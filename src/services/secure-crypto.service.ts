
import { Injectable } from '@angular/core';

export interface EncryptedPacket {
  data: string;
  iv: string;
  wrappedKey: string;
  keyIv: string;
}

@Injectable({
  providedIn: 'root'
})
export class SecureCryptoService {
  
  // Obfuscated Key Parts (XORed with 0x42)
  // Original: 'SHV_2025_AES_GCM_SECRET_KEY_777!'
  // This simulates a binary module where strings are not easily readable.
  private readonly _SEED_A = [17, 6, 20, 29, 112, 114, 112, 119]; // SHV_2025
  private readonly _SEED_B = [29, 127, 7, 17, 29, 5, 1, 15];     // _AES_GCM
  private readonly _SEED_C = [29, 17, 7, 1, 16, 7, 22, 29];      // _SECRET_
  private readonly _SEED_D = [9, 7, 27, 29, 121, 121, 121, 99];  // KEY_777!
  
  private _cachedKey: CryptoKey | null = null;

  constructor() {}

  /**
   * Reconstructs the Application Key (KEK) from obfuscated parts.
   * This logic mimics a secure module loader.
   */
  private async getAppKey(): Promise<CryptoKey> {
    if (this._cachedKey) return this._cachedKey;

    // Runtime De-obfuscation
    const combined = [
      ...this._SEED_A, 
      ...this._SEED_B, 
      ...this._SEED_C, 
      ...this._SEED_D
    ];
    
    // Apply XOR mask to recover original bytes
    const keyBytes = new Uint8Array(combined.map(b => b ^ 0x42));

    this._cachedKey = await window.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    
    // Clear buffer from memory immediately (best effort security)
    keyBytes.fill(0);
    
    return this._cachedKey;
  }

  private async generateDataKey(): Promise<CryptoKey> {
    return await window.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypts a Blob using Envelope Encryption (DEK + Wrapped DEK).
   */
  async encryptBlobEnvelope(blob: Blob): Promise<EncryptedPacket> {
    // 1. Generate ephemeral Data Encryption Key (DEK)
    const dek = await this.generateDataKey();
    
    // 2. Encrypt Content with DEK
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const arrayBuffer = await blob.arrayBuffer();
    const encryptedBuffer = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      dek,
      arrayBuffer
    );

    // 3. Wrap DEK with App Key (KEK)
    const kek = await this.getAppKey();
    const keyIv = window.crypto.getRandomValues(new Uint8Array(12));
    const dekRaw = await window.crypto.subtle.exportKey("raw", dek);
    const wrappedKeyBuffer = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: keyIv },
      kek,
      dekRaw
    );

    return {
      data: this.arrayBufferToBase64(encryptedBuffer),
      iv: this.arrayBufferToBase64(iv.buffer),
      wrappedKey: this.arrayBufferToBase64(wrappedKeyBuffer),
      keyIv: this.arrayBufferToBase64(keyIv.buffer)
    };
  }

  /**
   * Decrypts a Blob using Envelope Encryption.
   */
  async decryptBlobEnvelope(encryptedBase64: string, ivBase64: string, wrappedKeyBase64: string, keyIvBase64: string, mimeType: string): Promise<Blob> {
    try {
      // 1. Unwrap DEK using App Key
      const kek = await this.getAppKey();
      const keyIv = this.base64ToArrayBuffer(keyIvBase64);
      const wrappedKey = this.base64ToArrayBuffer(wrappedKeyBase64);
      
      const dekRaw = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(keyIv) },
        kek,
        wrappedKey
      );
      
      const dek = await window.crypto.subtle.importKey(
        "raw", 
        dekRaw, 
        { name: "AES-GCM" }, 
        false, 
        ["decrypt"]
      );

      // 2. Decrypt Content using DEK
      const iv = this.base64ToArrayBuffer(ivBase64);
      const encryptedData = this.base64ToArrayBuffer(encryptedBase64);
      
      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        dek,
        encryptedData
      );

      return new Blob([decryptedBuffer], { type: mimeType });

    } catch (e) {
      console.error("Crypto Error:", e);
      throw new Error("Decryption failed. The project key may not match or the data is corrupted.");
    }
  }

  // --- Utils ---

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
