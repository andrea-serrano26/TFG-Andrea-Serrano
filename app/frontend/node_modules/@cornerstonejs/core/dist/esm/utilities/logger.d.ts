import type { Logger as LogLevelLogger } from 'loglevel';
export type Logger = LogLevelLogger & {
    getLogger: (...categories: string[]) => Logger;
};
export declare function getRootLogger(name: string): Logger;
export declare function getLogger(...name: string[]): Logger;
export declare const cs3dLog: Logger;
export declare const coreLog: Logger;
export declare const toolsLog: Logger;
export declare const loaderLog: Logger;
export declare const aiLog: Logger;
export declare const examplesLog: Logger;
export declare const dicomConsistencyLog: Logger;
export declare const imageConsistencyLog: Logger;
