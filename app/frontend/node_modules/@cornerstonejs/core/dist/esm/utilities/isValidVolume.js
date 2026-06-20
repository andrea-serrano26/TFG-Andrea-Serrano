import * as metaData from '../metaData';
import isEqual from './isEqual';
function isValidVolume(imageIds) {
    if (!imageIds.length) {
        return false;
    }
    const imageId0 = imageIds[0];
    const { modality, seriesInstanceUID } = metaData.get('generalSeriesModule', imageId0);
    const { imageOrientationPatient, pixelSpacing, frameOfReferenceUID, columns, rows, usingDefaultValues, } = metaData.get('imagePlaneModule', imageId0);
    if (usingDefaultValues) {
        return false;
    }
    const baseMetadata = {
        modality,
        imageOrientationPatient,
        pixelSpacing,
        frameOfReferenceUID,
        columns,
        rows,
        seriesInstanceUID,
    };
    let validVolume = true;
    for (let i = 0; i < imageIds.length; i++) {
        const imageId = imageIds[i];
        const { modality, seriesInstanceUID } = metaData.get('generalSeriesModule', imageId);
        const { imageOrientationPatient, pixelSpacing, columns, rows } = metaData.get('imagePlaneModule', imageId);
        if (seriesInstanceUID !== baseMetadata.seriesInstanceUID) {
            validVolume = false;
            break;
        }
        if (modality !== baseMetadata.modality) {
            validVolume = false;
            break;
        }
        if (columns !== baseMetadata.columns) {
            validVolume = false;
            break;
        }
        if (rows !== baseMetadata.rows) {
            validVolume = false;
            break;
        }
        if (!isEqual(imageOrientationPatient, baseMetadata.imageOrientationPatient)) {
            validVolume = false;
            break;
        }
        if (!isEqual(pixelSpacing, baseMetadata.pixelSpacing)) {
            validVolume = false;
            break;
        }
    }
    return validVolume;
}
export { isValidVolume };
