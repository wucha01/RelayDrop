package app.relaydrop;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Fixed-buffer integrity checks shared by HTTP saves and Bluetooth transfers. */
final class FileIntegrity {
    interface Check { void run() throws IOException; }
    static final class Value {
        final long size; final byte[] sha256;
        Value(long size, byte[] sha256) { this.size = size; this.sha256 = sha256.clone(); }
    }
    static final class Mismatch extends IOException {
        Mismatch(String message) { super(message); }
    }
    static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    static byte[] parseEtag(String etag) throws IOException {
        if (etag == null || !etag.matches("\"[a-fA-F0-9]{64}\""))
            throw new IOException("中转站未提供有效的完整 SHA-256 校验值，已拒绝保存。");
        return fromHex(etag.substring(1, 65));
    }
    static byte[] fromHex(String value) throws IOException {
        if (value == null || !value.matches("[a-fA-F0-9]{64}")) throw new IOException("文件校验记录无效。");
        byte[] bytes = new byte[32];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }
    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) { out.append(Character.forDigit((b >>> 4) & 15, 16)); out.append(Character.forDigit(b & 15, 16)); }
        return out.toString();
    }
    static Value read(InputStream input, long expectedLength, Check check) throws IOException {
        if (input == null || expectedLength < 0) throw new IOException("文件长度或读取权限无效。");
        MessageDigest digest = digest(); byte[] buffer = new byte[64 * 1024]; long total = 0;
        while (true) {
            check.run(); int count = input.read(buffer); if (count == -1) break; if (count == 0) continue;
            if (count > expectedLength - total) throw new Mismatch("文件长度与预期不一致。");
            digest.update(buffer, 0, count); total += count;
        }
        check.run(); if (total != expectedLength) throw new Mismatch("文件未完整到达。");
        return new Value(total, digest.digest());
    }
    static void require(Value actual, Value expected) throws IOException {
        if (actual.size != expected.size || !MessageDigest.isEqual(actual.sha256, expected.sha256))
            throw new Mismatch("文件内容或长度与预期不一致。");
    }
    private FileIntegrity() { }
}
