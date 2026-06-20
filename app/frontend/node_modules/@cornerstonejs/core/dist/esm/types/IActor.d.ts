import type vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import type vtkImageSlice from '@kitware/vtk.js/Rendering/Core/ImageSlice';
import type vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import type CanvasActor from '../RenderingEngine/CanvasActor';
import type { BlendModes } from '../enums';
export type Actor = vtkActor;
export type VolumeActor = vtkVolume;
export type ImageActor = vtkImageSlice;
export type ICanvasActor = CanvasActor;
export interface ActorEntry {
    uid: string;
    actor: Actor | VolumeActor | ImageActor | ICanvasActor;
    referencedId?: string;
    slabThickness?: number;
    clippingFilter?: any;
    blendMode?: BlendModes;
    callbacks?: ({ volumeActor, volumeId, }: {
        volumeActor: VolumeActor;
        volumeId: string;
    }) => void;
    [key: string]: unknown;
}
