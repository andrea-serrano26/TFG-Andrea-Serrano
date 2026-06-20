const providers = [];
export function addProvider(provider, priority = 0) {
    let i;
    for (i = 0; i < providers.length; i++) {
        if (providers[i].priority <= priority) {
            break;
        }
    }
    providers.splice(i, 0, {
        priority,
        provider,
    });
}
export function removeProvider(provider) {
    for (let i = 0; i < providers.length; i++) {
        if (providers[i].provider === provider) {
            providers.splice(i, 1);
            break;
        }
    }
}
export function removeAllProviders() {
    while (providers.length > 0) {
        providers.pop();
    }
}
function getMetaData(type, ...queries) {
    for (let i = 0; i < providers.length; i++) {
        const result = providers[i].provider(type, ...queries);
        if (result !== undefined) {
            return result;
        }
    }
}
export function getNormalized(imageId, types, metaDataProvider = getMetaData) {
    const result = {};
    for (const t of types) {
        try {
            const data = metaDataProvider(t, imageId);
            if (data) {
                const capitalizedData = {};
                for (const key in data) {
                    if (key in data) {
                        const capitalizedKey = toUpperCamelTag(key);
                        capitalizedData[capitalizedKey] = data[key];
                    }
                }
                Object.assign(result, capitalizedData);
            }
        }
        catch (error) {
            console.error(`Error retrieving ${t} data:`, error);
        }
    }
    return result;
}
export const toUpperCamelTag = (tag) => {
    if (tag.startsWith('sop')) {
        return `SOP${tag.substring(3)}`;
    }
    if (tag.endsWith('Id')) {
        tag = `${tag.substring(0, tag.length - 2)}ID`;
    }
    return tag.charAt(0).toUpperCase() + tag.slice(1);
};
export const toLowerCamelTag = (tag) => {
    if (tag.startsWith('SOP')) {
        return `sop${tag.substring(3)}`;
    }
    if (tag.endsWith('ID')) {
        tag = `${tag.substring(0, tag.length - 2)}Id`;
    }
    return tag.charAt(0).toLowerCase() + tag.slice(1);
};
export { getMetaData as get };
