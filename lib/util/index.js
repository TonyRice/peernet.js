const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() + new Date().getTime())  * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function randomData() {
    // TODO make this more random
    return uuidv4() + '-' + uuidv4();
}

module.exports = {
    sleep,
    uuidv4,
    randomData
}