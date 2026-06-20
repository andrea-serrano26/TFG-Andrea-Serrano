import { metaData, registerImageLoader } from '@cornerstonejs/core';
import loadImage from './loadImage';
import { metaDataProvider } from './metaData';
export default function () {
    registerImageLoader('wadors', loadImage);
    metaData.addProvider(metaDataProvider);
}
