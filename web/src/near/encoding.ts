const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("Invalid base64 string");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET.charAt(Number(value % 58n)) + encoded;
    value /= 58n;
  }

  // Each leading zero byte is one leading "1".
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  return "1".repeat(leadingZeros) + encoded;
}

export function base58ToBytes(base58: string): Uint8Array<ArrayBuffer> {
  let value = 0n;
  for (const character of base58) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit === -1) throw new Error("Invalid base58 string");
    value = value * 58n + BigInt(digit);
  }

  const tail: number[] = [];
  while (value > 0n) {
    tail.unshift(Number(value % 256n));
    value /= 256n;
  }

  let leadingZeros = 0;
  while (leadingZeros < base58.length && base58[leadingZeros] === "1") leadingZeros += 1;
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...tail]);
}
