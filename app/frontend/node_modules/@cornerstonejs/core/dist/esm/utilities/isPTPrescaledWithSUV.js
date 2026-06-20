const isPTPrescaledWithSUV = (image) => {
    return image.preScale.scaled && image.preScale.scalingParameters.suvbw;
};
export default isPTPrescaledWithSUV;
