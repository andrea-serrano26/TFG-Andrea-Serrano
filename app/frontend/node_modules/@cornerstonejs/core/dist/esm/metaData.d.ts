export declare function addProvider(provider: (type: string, ...query: string[]) => unknown, priority?: number): void;
export declare function removeProvider(provider: (type: string, query: unknown) => unknown): void;
export declare function removeAllProviders(): void;
declare function getMetaData(type: string, ...queries: any[]): any;
export declare function getNormalized(imageId: string, types: string[], metaDataProvider?: typeof getMetaData): {};
export declare const toUpperCamelTag: (tag: string) => string;
export declare const toLowerCamelTag: (tag: string) => string;
export { getMetaData as get };
