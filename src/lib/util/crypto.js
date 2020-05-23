import * as openpgp from 'openpgp';

const privateKeyCache = new Map();

export async function generateKeyPair(name, email, password) {
    return await openpgp.generateKey({
        userIds: [{name: name, email: email}], // you can pass multiple user IDs
        curve: 'ed25519',
        passphrase: password
    })
}

export async function encrypt(publicKey, message) {
    const {data: encrypted} = await openpgp.encrypt({
        message: openpgp.message.fromText(message),
        publicKeys: (await openpgp.key.readArmored(publicKey)).keys
    });

    return encrypted;
}

export async function decrypt(privateKeyText, password, message) {
    const {data: decrypted} = await openpgp.decrypt({
        message: await openpgp.message.readArmored(message),
        privateKeys: [await readPrivateKey(privateKeyText, password)]
    });

    return decrypted;
}

export async function readPrivateKey(privateKeyText, password) {
    if (privateKeyCache.has(privateKeyText)) {
        return privateKeyCache.get(privateKeyText);
    }

    const {keys: [privateKey]} = await openpgp.key.readArmored(privateKeyText);
    await privateKey.decrypt(password);

    privateKeyCache.set(privateKeyText, privateKey);

    return privateKey;
}

export async function sign(privateKeyText, password, message) {
    const { data: signed } = await openpgp.sign({
        message: openpgp.cleartext.fromText(message),
        privateKeys: [await readPrivateKey(privateKeyText, password)]
    });

    return signed;
}

export async function verify(publicKey, message) {
    const verified = await openpgp.verify({
        message: await openpgp.cleartext.readArmored(message),
        publicKeys: (await openpgp.key.readArmored(publicKey)).keys
    });
    const { valid } = verified.signatures[0];

    if (valid) {
        return verified.data;
    }

    return null;
}