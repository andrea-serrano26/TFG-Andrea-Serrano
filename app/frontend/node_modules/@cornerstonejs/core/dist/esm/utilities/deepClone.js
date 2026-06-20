export function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (typeof obj === 'function') {
        return obj;
    }
    if (typeof structuredClone === 'function') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(deepClone);
    }
    else {
        const clonedObj = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                clonedObj[key] = deepClone(obj[key]);
            }
        }
        return clonedObj;
    }
}
