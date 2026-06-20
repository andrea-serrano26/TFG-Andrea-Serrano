import type { IBaseVolumeViewport, IStackViewport } from '../types';
type Viewport = IStackViewport | IBaseVolumeViewport;
export default function getViewportsWithImageURI(imageURI: string): Viewport[];
export {};
