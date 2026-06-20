import loglevelImport from 'loglevel';
const loglevel = loglevelImport.noConflict();
if (typeof window !== 'undefined') {
    window.log = loglevel;
}
export function getRootLogger(name) {
    const logger = loglevel.getLogger(name[0]);
    logger.getLogger = (...names) => {
        return getRootLogger(`${name}.${names.join('.')}`);
    };
    return logger;
}
export function getLogger(...name) {
    return getRootLogger(name.join('.'));
}
export const cs3dLog = getRootLogger('cs3d');
export const coreLog = cs3dLog.getLogger('core');
export const toolsLog = cs3dLog.getLogger('tools');
export const loaderLog = cs3dLog.getLogger('dicomImageLoader');
export const aiLog = cs3dLog.getLogger('ai');
export const examplesLog = cs3dLog.getLogger('examples');
export const dicomConsistencyLog = getLogger('consistency', 'dicom');
export const imageConsistencyLog = getLogger('consistency', 'image');
