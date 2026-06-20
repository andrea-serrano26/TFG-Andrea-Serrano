export declare function isEqual<ValueType>(v1: ValueType, v2: ValueType, tolerance?: number): boolean;
export declare const isEqualNegative: <ValueType>(v1: ValueType, v2: ValueType, tolerance?: any) => boolean;
export declare const isEqualAbs: <ValueType>(v1: ValueType, v2: ValueType, tolerance?: any) => boolean;
export declare function isNumber(n: number[] | number): boolean;
export default isEqual;
