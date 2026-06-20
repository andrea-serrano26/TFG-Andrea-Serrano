import { vec3, mat4 } from 'gl-matrix';
import { Events as EVENTS, MetadataModules } from '../enums';
import uuidv4 from '../utilities/uuidv4';
import * as metaData from '../metaData';
import { Transform } from './helpers/cpuFallback/rendering/transform';
import Viewport from './Viewport';
import { getOrCreateCanvas } from './helpers';
import { EPSILON } from '../constants';
import triggerEvent from '../utilities/triggerEvent';
import { peerImport } from '../init';
import microscopyViewportCss from '../constants/microscopyViewportCss';
import eventTarget from '../eventTarget';
import imageIdToURI from '../utilities/imageIdToURI';
let WSIUtilFunctions = null;
const EVENT_POSTRENDER = 'postrender';
const ANNOTATION_REMOVED = 'CORNERSTONE_TOOLS_ANNOTATION_REMOVED';
class WSIViewport extends Viewport {
    constructor(props) {
        super({
            ...props,
            canvas: props.canvas || getOrCreateCanvas(props.element),
        });
        this.imageURISet = new Set();
        this.internalCamera = {
            rotation: 0,
            centerIndex: [0, 0],
            extent: [0, -2, 1, -1],
            xSpacing: 1,
            ySpacing: 1,
            resolution: 1,
            zoom: 1,
        };
        this.annotationRemovedListener = (evt) => {
            const { detail } = evt;
            const metadata = detail?.annotation?.metadata;
            if (!metadata) {
                this.postrender();
                return;
            }
            const referencedImageURI = metadata.referencedImageURI ??
                (metadata.referencedImageId
                    ? imageIdToURI(metadata.referencedImageId)
                    : null);
            if (referencedImageURI && !this.hasImageURI(referencedImageURI)) {
                return;
            }
            const annotationFOR = metadata.FrameOfReferenceUID ?? null;
            if (annotationFOR && annotationFOR !== this.frameOfReferenceUID) {
                return;
            }
            this.postrender();
        };
        this.voiRange = {
            lower: 0,
            upper: 255,
        };
        this.getProperties = () => {
            return {
                voiRange: { ...this.voiRange },
            };
        };
        this.resetCamera = () => {
            return true;
        };
        this.getNumberOfSlices = () => {
            return 1;
        };
        this.getFrameOfReferenceUID = () => {
            return this.frameOfReferenceUID;
        };
        this.resize = () => {
            const canvas = this.canvas;
            const { clientWidth, clientHeight } = canvas;
            if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
                canvas.width = clientWidth;
                canvas.height = clientHeight;
            }
            this.refreshRenderValues();
        };
        this.canvasToWorld = (canvasPos) => {
            if (!this.metadata) {
                return;
            }
            const indexPoint = this.canvasToIndex(canvasPos);
            indexPoint[1] = -indexPoint[1];
            return this.indexToWorld(indexPoint);
        };
        this.worldToCanvas = (worldPos) => {
            if (!this.metadata) {
                return;
            }
            const indexPoint = this.worldToIndex(worldPos);
            indexPoint[1] = -indexPoint[1];
            const canvasPoint = this.indexToCanvas([indexPoint[0], indexPoint[1], 0]);
            return canvasPoint;
        };
        this.postrender = () => {
            this.refreshRenderValues();
            triggerEvent(this.element, EVENTS.IMAGE_RENDERED, {
                element: this.element,
                viewportId: this.id,
                viewport: this,
                renderingEngineId: this.renderingEngineId,
            });
        };
        this.getRotation = () => 0;
        this.canvasToIndex = (canvasPos) => {
            const transform = this.getTransform();
            transform.invert();
            const indexPoint = transform.transformPoint(canvasPos.map((it) => it * devicePixelRatio));
            return [indexPoint[0], indexPoint[1], 0];
        };
        this.indexToCanvas = (indexPos) => {
            const transform = this.getTransform();
            return transform
                .transformPoint([indexPos[0], indexPos[1]])
                .map((it) => it / devicePixelRatio);
        };
        this.customRenderViewportToCanvas = () => {
        };
        this.getImageIds = () => {
            return [this.imageIds[0]];
        };
        this.renderingEngineId = props.renderingEngineId;
        this.element.setAttribute('data-viewport-uid', this.id);
        this.element.setAttribute('data-rendering-engine-uid', this.renderingEngineId);
        this.element.style.position = 'relative';
        this.microscopyElement = document.createElement('div');
        this.microscopyElement.setAttribute('class', 'DicomMicroscopyViewer');
        this.microscopyElement.id = uuidv4();
        this.microscopyElement.innerText = 'Initial';
        this.microscopyElement.style.background = 'grey';
        this.microscopyElement.style.width = '100%';
        this.microscopyElement.style.height = '100%';
        this.microscopyElement.style.position = 'absolute';
        this.microscopyElement.style.left = '0';
        this.microscopyElement.style.top = '0';
        const cs3dElement = this.element.firstElementChild;
        cs3dElement.insertBefore(this.microscopyElement, cs3dElement.childNodes[1]);
        this.addEventListeners();
        this.addWidget('DicomMicroscopyViewer', {
            getEnabled: () => !!this.viewer,
            setEnabled: () => {
                this.elementDisabledHandler();
            },
        });
        this.resize();
    }
    static get useCustomRenderingPipeline() {
        return true;
    }
    addEventListeners() {
        this.canvas.addEventListener(EVENTS.ELEMENT_DISABLED, this.elementDisabledHandler);
        eventTarget.addEventListener(ANNOTATION_REMOVED, this.annotationRemovedListener);
    }
    removeEventListeners() {
        this.canvas.removeEventListener(EVENTS.ELEMENT_DISABLED, this.elementDisabledHandler);
        eventTarget.removeEventListener(ANNOTATION_REMOVED, this.annotationRemovedListener);
    }
    elementDisabledHandler() {
        this.removeEventListeners();
        this.viewer?.cleanup();
        this.viewer = null;
        const cs3dElement = this.element.firstElementChild;
        cs3dElement.removeChild(this.microscopyElement);
        this.microscopyElement = null;
        this.imageURISet.clear();
    }
    getImageDataMetadata(imageIndex = 0) {
        const maxImage = this.metadataDicomweb.reduce((maxImage, image) => {
            return maxImage?.NumberOfFrames < image.NumberOfFrames ? image : maxImage;
        });
        const { TotalPixelMatrixColumns: columns, TotalPixelMatrixRows: rows, ImageOrientationSlide, ImagedVolumeWidth: width, ImagedVolumeHeight: height, ImagedVolumeDepth: depth, } = maxImage;
        const imagePlaneModule = metaData.get(MetadataModules.IMAGE_PLANE, this.imageIds[imageIndex]);
        let rowCosines = ImageOrientationSlide.slice(0, 3);
        let columnCosines = ImageOrientationSlide.slice(3, 6);
        if (rowCosines == null || columnCosines == null) {
            rowCosines = [1, 0, 0];
            columnCosines = [0, 1, 0];
        }
        const rowCosineVec = vec3.fromValues(rowCosines[0], rowCosines[1], rowCosines[2]);
        const colCosineVec = vec3.fromValues(columnCosines[0], columnCosines[1], columnCosines[2]);
        const scanAxisNormal = vec3.create();
        vec3.cross(scanAxisNormal, rowCosineVec, colCosineVec);
        const { XOffsetInSlideCoordinateSystem = 0, YOffsetInSlideCoordinateSystem = 0, ZOffsetInSlideCoordinateSystem = 0, } = maxImage.TotalPixelMatrixOriginSequence?.[0] || {};
        const origin = [
            XOffsetInSlideCoordinateSystem,
            YOffsetInSlideCoordinateSystem,
            ZOffsetInSlideCoordinateSystem,
        ];
        const xSpacing = width / columns;
        const ySpacing = height / rows;
        const xVoxels = columns;
        const yVoxels = rows;
        const zSpacing = depth;
        const zVoxels = 1;
        this.hasPixelSpacing = !!(width && height);
        return {
            bitsAllocated: 8,
            numberOfComponents: 3,
            origin,
            direction: [...rowCosineVec, ...colCosineVec, ...scanAxisNormal],
            dimensions: [xVoxels, yVoxels, zVoxels],
            spacing: [xSpacing, ySpacing, zSpacing],
            hasPixelSpacing: this.hasPixelSpacing,
            numVoxels: xVoxels * yVoxels * zVoxels,
            imagePlaneModule,
        };
    }
    async setFrameNumber(frame) {
    }
    setProperties(props) {
        if (props.voiRange) {
            this.setVOI(props.voiRange);
        }
    }
    resetProperties() {
        this.setProperties({
            voiRange: {
                lower: 0,
                upper: 255,
            },
        });
    }
    setVOI(voiRange) {
        this.voiRange = voiRange;
        const feFilter = this.setColorTransform(voiRange, this.averageWhite);
        const olCanvases = this.map
            .getViewport()
            .querySelectorAll('.ol-layers canvas');
        olCanvases.forEach((canvas) => {
            canvas.style.filter = feFilter;
        });
    }
    setAverageWhite(averageWhite) {
        this.averageWhite = averageWhite;
        this.setColorTransform(this.voiRange, averageWhite);
    }
    getScalarData() {
        return null;
    }
    computeTransforms() {
        const indexToWorld = mat4.create();
        const worldToIndex = mat4.create();
        mat4.fromTranslation(indexToWorld, this.metadata.origin);
        indexToWorld[0] = this.metadata.direction[0];
        indexToWorld[1] = this.metadata.direction[1];
        indexToWorld[2] = this.metadata.direction[2];
        indexToWorld[4] = this.metadata.direction[3];
        indexToWorld[5] = this.metadata.direction[4];
        indexToWorld[6] = this.metadata.direction[5];
        indexToWorld[8] = this.metadata.direction[6];
        indexToWorld[9] = this.metadata.direction[7];
        indexToWorld[10] = this.metadata.direction[8];
        mat4.scale(indexToWorld, indexToWorld, this.metadata.spacing);
        mat4.invert(worldToIndex, indexToWorld);
        return { indexToWorld, worldToIndex };
    }
    getImageData() {
        const { metadata } = this;
        if (!metadata) {
            return null;
        }
        const { spacing } = metadata;
        const imageData = {
            getDirection: () => metadata.direction,
            getDimensions: () => metadata.dimensions,
            getRange: () => [0, 255],
            getScalarData: () => this.getScalarData(),
            getSpacing: () => metadata.spacing,
            worldToIndex: (point) => {
                return this.worldToIndex(point);
            },
            indexToWorld: (point) => {
                return this.indexToWorld(point);
            },
        };
        const imageDataReturn = {
            dimensions: metadata.dimensions,
            spacing,
            numberOfComponents: 3,
            origin: metadata.origin,
            direction: metadata.direction,
            metadata: {
                Modality: this.modality,
                FrameOfReferenceUID: this.frameOfReferenceUID,
            },
            hasPixelSpacing: this.hasPixelSpacing,
            calibration: this.calibration,
            preScale: {
                scaled: false,
            },
            scalarData: this.getScalarData(),
            imageData,
        };
        return imageDataReturn;
    }
    hasImageURI(imageURI) {
        if (!imageURI) {
            return false;
        }
        return this.imageURISet.has(imageURI);
    }
    setCamera(camera) {
        const previousCamera = this.getCamera();
        const { parallelScale, focalPoint } = camera;
        const view = this.getView();
        const { xSpacing } = this.internalCamera;
        if (parallelScale) {
            const worldToCanvasRatio = this.element.clientHeight / parallelScale;
            const resolution = 1 / xSpacing / worldToCanvasRatio;
            view.setResolution(resolution);
        }
        if (focalPoint) {
            const newCanvas = this.worldToCanvas(focalPoint);
            const newIndex = this.canvasToIndex(newCanvas);
            view.setCenter(newIndex);
        }
        const updatedCamera = this.getCamera();
        this.triggerCameraModifiedEventIfNecessary(previousCamera, updatedCamera);
    }
    getCurrentImageId() {
        return this.imageIds[0];
    }
    getFrameNumber() {
        return 1;
    }
    getCamera() {
        this.refreshRenderValues();
        const { resolution, xSpacing, centerIndex } = this.internalCamera;
        const canvasToWorldRatio = resolution * xSpacing;
        const canvasCenter = this.indexToCanvas([
            centerIndex[0],
            centerIndex[1],
            0,
        ]);
        const focalPoint = this.canvasToWorld(canvasCenter);
        return {
            parallelProjection: true,
            focalPoint,
            position: focalPoint,
            viewUp: [0, -1, 0],
            parallelScale: this.element.clientHeight * canvasToWorldRatio,
            viewPlaneNormal: [0, 0, 1],
        };
    }
    static { this.getDicomMicroscopyViewer = async () => {
        return peerImport('dicom-microscopy-viewer');
    }; }
    worldToIndexWSI(point) {
        if (!WSIUtilFunctions) {
            return;
        }
        const affine = this.viewer.getAffine();
        const pixelCoords = WSIUtilFunctions.applyInverseTransform({
            coordinate: [point[0], point[1]],
            affine,
        });
        return [pixelCoords[0], pixelCoords[1]];
    }
    indexToWorldWSI(point) {
        if (!WSIUtilFunctions) {
            return;
        }
        const sliceCoords = WSIUtilFunctions.applyTransform({
            coordinate: [point[0], point[1]],
            affine: this.viewer.getAffine(),
        });
        return [sliceCoords[0], sliceCoords[1], 0];
    }
    worldToIndex(point) {
        const { worldToIndex: worldToIndexMatrix } = this.computeTransforms();
        const imageCoord = vec3.create();
        vec3.transformMat4(imageCoord, point, worldToIndexMatrix);
        return imageCoord;
    }
    indexToWorld(point) {
        const { indexToWorld: indexToWorldMatrix } = this.computeTransforms();
        const worldPos = vec3.create();
        const point3D = vec3.fromValues(...point);
        vec3.transformMat4(worldPos, point3D, indexToWorldMatrix);
        return [worldPos[0], worldPos[1], worldPos[2]];
    }
    setDataIds(imageIds, options) {
        if (options?.miniNavigationOverlay !== false) {
            WSIViewport.addMiniNavigationOverlayCss();
        }
        const webClient = options?.webClient ||
            metaData.get(MetadataModules.WADO_WEB_CLIENT, imageIds[0]);
        if (!webClient) {
            throw new Error(`To use setDataIds on WSI data, you must provide metaData.webClient for ${imageIds[0]}.`);
        }
        return this.setWSI(imageIds, webClient);
    }
    async setWSI(imageIds, client) {
        this.microscopyElement.style.background = 'black';
        this.microscopyElement.innerText = 'Loading';
        this.imageIds = imageIds;
        this.imageURISet = new Set(imageIds.map((imageId) => imageIdToURI(imageId)));
        const DicomMicroscopyViewer = await WSIViewport.getDicomMicroscopyViewer();
        WSIUtilFunctions ||= DicomMicroscopyViewer.utils;
        this.frameOfReferenceUID = null;
        const metadataDicomweb = this.imageIds.map((imageId) => {
            const imageMetadata = client.getDICOMwebMetadata(imageId);
            Object.defineProperty(imageMetadata, 'isMultiframe', {
                value: imageMetadata.isMultiframe,
                enumerable: false,
            });
            Object.defineProperty(imageMetadata, 'frameNumber', {
                value: undefined,
                enumerable: false,
            });
            const imageType = imageMetadata['00080008']?.Value;
            if (imageType?.length === 1) {
                imageMetadata['00080008'].Value = imageType[0].split('\\');
            }
            const frameOfReference = imageMetadata['00200052']?.Value?.[0];
            if (!this.frameOfReferenceUID) {
                this.frameOfReferenceUID = frameOfReference;
            }
            else if (frameOfReference !== this.frameOfReferenceUID) {
                imageMetadata['00200052'].Value = [this.frameOfReferenceUID];
            }
            return imageMetadata;
        });
        const volumeImages = [];
        metadataDicomweb.forEach((m) => {
            const image = new DicomMicroscopyViewer.metadata.VLWholeSlideMicroscopyImage({
                metadata: m,
            });
            const imageFlavor = image.ImageType[2];
            if (imageFlavor === 'VOLUME' || imageFlavor === 'THUMBNAIL') {
                volumeImages.push(image);
            }
            else {
                console.log('Unknown image type', image.ImageType);
            }
        });
        this.metadataDicomweb = volumeImages;
        const viewer = new DicomMicroscopyViewer.viewer.VolumeImageViewer({
            client,
            metadata: volumeImages,
            controls: ['overview', 'position'],
            retrieveRendered: false,
            bindings: {},
        });
        viewer.render({ container: this.microscopyElement });
        this.metadata = this.getImageDataMetadata();
        viewer.deactivateDragPanInteraction();
        this.viewer = viewer;
        this.map = viewer.getMap();
        this.map.on(EVENT_POSTRENDER, this.postrender);
        this.resize();
        this.microscopyElement.innerText = '';
        Object.assign(this.microscopyElement.style, {
            '--ol-partial-background-color': 'rgba(127, 127, 127, 0.7)',
            '--ol-foreground-color': '#000000',
            '--ol-subtle-foreground-color': '#000',
            '--ol-subtle-background-color': 'rgba(78, 78, 78, 0.5)',
            background: 'none',
        });
    }
    scroll(delta) {
        const camera = this.getCamera();
        this.setCamera({
            parallelScale: camera.parallelScale * (1 + 0.1 * delta),
        });
    }
    getSliceIndex() {
        return 0;
    }
    getView() {
        if (!this.viewer) {
            return;
        }
        const map = this.viewer.getMap();
        const anyWindow = window;
        anyWindow.map = map;
        anyWindow.viewer = this.viewer;
        anyWindow.view = map?.getView();
        anyWindow.wsi = this;
        return map?.getView();
    }
    refreshRenderValues() {
        const view = this.getView();
        if (!view) {
            return;
        }
        const resolution = view.getResolution();
        if (!resolution || resolution < EPSILON) {
            return;
        }
        const centerIndex = view.getCenter();
        const extent = view.getProjection().getExtent();
        const rotation = view.getRotation();
        const zoom = view.getZoom();
        const { metadata: { spacing: [xSpacing, ySpacing], }, } = this;
        const worldToCanvasRatio = 1 / resolution / xSpacing;
        Object.assign(this.internalCamera, {
            extent,
            centerIndex,
            worldToCanvasRatio,
            xSpacing,
            ySpacing,
            resolution,
            rotation,
            zoom,
        });
    }
    getZoom() {
        return this.getView()?.getZoom();
    }
    setZoom(zoom) {
        this.getView()?.setZoom(zoom);
    }
    getTransform() {
        this.refreshRenderValues();
        const { centerIndex: center, resolution, rotation } = this.internalCamera;
        const halfCanvas = [this.canvas.width / 2, this.canvas.height / 2];
        const transform = new Transform();
        transform.translate(halfCanvas[0], halfCanvas[1]);
        transform.rotate(rotation);
        transform.scale(1 / resolution, -1 / resolution);
        transform.translate(-center[0], -center[1]);
        return transform;
    }
    getViewReferenceId() {
        return `imageId:${this.getCurrentImageId()}`;
    }
    getCurrentImageIdIndex() {
        return 0;
    }
    static { this.overlayCssId = 'overlayCss'; }
    static addMiniNavigationOverlayCss() {
        if (document.getElementById(this.overlayCssId)) {
            return;
        }
        const overlayCss = document.createElement('style');
        overlayCss.innerText = microscopyViewportCss;
        overlayCss.setAttribute('id', this.overlayCssId);
        document.getElementsByTagName('head')[0].append(overlayCss);
    }
}
export default WSIViewport;
