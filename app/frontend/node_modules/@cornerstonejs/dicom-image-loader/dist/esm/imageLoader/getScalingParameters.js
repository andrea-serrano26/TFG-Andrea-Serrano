export default function getScalingParameters(metaData, imageId) {
    const modalityLutModule = metaData.get('modalityLutModule', imageId) || {};
    const generalSeriesModule = (metaData.get('generalSeriesModule', imageId) ||
        {});
    const { modality } = generalSeriesModule;
    const scalingParameters = {
        rescaleSlope: modalityLutModule.rescaleSlope,
        rescaleIntercept: modalityLutModule.rescaleIntercept,
        modality,
    };
    const scalingModules = metaData.get('scalingModule', imageId) || {};
    return {
        ...scalingParameters,
        ...(modality === 'PT' && { suvbw: scalingModules.suvbw }),
        ...(modality === 'RTDOSE' && {
            doseGridScaling: scalingModules.DoseGridScaling,
            doseSummation: scalingModules.DoseSummation,
            doseType: scalingModules.DoseType,
            doseUnit: scalingModules.DoseUnit,
        }),
    };
}
