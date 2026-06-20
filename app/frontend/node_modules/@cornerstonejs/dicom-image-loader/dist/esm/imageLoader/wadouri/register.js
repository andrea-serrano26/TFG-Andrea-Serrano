import { metaData, registerImageLoader } from '@cornerstonejs/core';
import { loadImage } from './loadImage';
import { metaDataProvider } from './metaData/index';
export default function () {
    registerImageLoader('dicomweb', loadImage);
    registerImageLoader('wadouri', loadImage);
    registerImageLoader('dicomfile', loadImage);
    metaData.addProvider(metaDataProvider);
}
