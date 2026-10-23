package app.relaydrop;

import android.content.ContentResolver;
import android.database.ContentObserver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Deletes only this failed SAF document after Downloads has acknowledged its writer close. */
final class SafDocumentCleanup implements AutoCloseable {
    private final ContentResolver resolver;
    private final Uri document;
    private final CountDownLatch closeAcknowledged = new CountDownLatch(1);
    private final boolean downloads;
    private final String documentId;
    private ContentObserver observer;
    private String displayName;
    private volatile boolean closing, opened;

    SafDocumentCleanup(ContentResolver resolver, Uri document) {
        this.resolver = resolver; this.document = document;
        String id = null;
        try { id = DocumentsContract.getDocumentId(document); } catch (Exception ignored) { }
        documentId = id;
        downloads = "com.android.providers.downloads.documents".equals(document.getAuthority())
                && id != null && id.matches("[0-9]+");

        // Downloads' close callback updates MediaStore before notifying the exact download URI.
        // A collection-only notification or unrelated download cannot acknowledge this writer.
        try (Cursor cursor = resolver.query(document, new String[]{DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) { int index = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME); if (index >= 0) displayName = cursor.getString(index); }
            if (!downloads) return;
            Uri notification = cursor == null ? null : cursor.getNotificationUri();
            if (notification == null || !"downloads".equals(notification.getAuthority())) return;
            observer = new ContentObserver(null) {
                @Override public void onChange(boolean selfChange, Uri changed) {
                    if (closing && changed != null && "downloads".equals(changed.getAuthority())
                            && documentId.equals(changed.getLastPathSegment())) closeAcknowledged.countDown();
                }
            };
            resolver.registerContentObserver(notification, true, observer);
        } catch (Exception ignored) { close(); }
    }

    String displayName(String fallback) { return displayName == null || displayName.trim().isEmpty() ? "刚才选择的目标文件（原始建议名称：" + fallback + "）" : displayName; }

    OutputStream open(String mode) throws IOException {
        OutputStream output = resolver.openOutputStream(document, mode);
        if (output == null) throw new IOException("无法写入所选位置");
        opened = true;
        return new FilterOutputStream(output) {
            @Override public void write(byte[] bytes, int offset, int length) throws IOException { out.write(bytes, offset, length); }
            @Override public void close() throws IOException { closing = true; super.close(); }
        };
    }

    void verifySaved(FileIntegrity.Value expected, FileIntegrity.Check check) throws IOException {
        // The write stream must be closed before this independent read begins.
        if (!opened || !closing) throw new IOException("目标文件尚未关闭，无法确认完整性。");
        try (InputStream input = resolver.openInputStream(document)) {
            if (input == null) throw new IOException("目标位置不允许重新读取。");
            FileIntegrity.require(FileIntegrity.read(input, expected.size, check), expected);
        } catch (FileIntegrity.Mismatch e) {
            throw new IOException("保存后的文件读回校验失败，未确认完整性，请重新保存。", e);
        } catch (IOException | SecurityException e) {
            throw new IOException("无法重新读取已保存文件，完整性尚未验证。请换一个允许读写的位置。", e);
        }
    }

    boolean deleteIncomplete() {
        if (downloads && opened) {
            if (observer == null) return false;
            try { if (!closeAcknowledged.await(2500, TimeUnit.MILLISECONDS)) return false; }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        }
        try { return DocumentsContract.deleteDocument(resolver, document); }
        catch (Exception ignored) { return false; }
    }

    @Override public void close() {
        ContentObserver current = observer; observer = null;
        if (current != null) try { resolver.unregisterContentObserver(current); } catch (Exception ignored) { }
    }
}