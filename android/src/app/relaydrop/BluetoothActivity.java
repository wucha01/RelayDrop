package app.relaydrop;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.AtomicFile;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;
import android.webkit.MimeTypeMap;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Standalone Android-to-Android secure RFCOMM file transfer; no network/AI dependency. */
public final class BluetoothActivity extends SecureActivity {
    private static final UUID SERVICE_UUID = UUID.fromString("75886e21-bd51-4f2a-bf0a-df25d4b61a8a");
    private static final String MAGIC = "RelayDrop-BT-1";
    private static final int PICK_FILES = 210, SAVE_FILE = 211, ENABLE_BT = 212, PERMISSION_BT = 213;
    private static final int MAX_FILES = 20, BUFFER_SIZE = 64 * 1024;
    private static final long MAX_FILE = 512L * 1024 * 1024, MAX_BATCH = 2L * 1024 * 1024 * 1024;
    private static final long RESERVE = 16L * 1024 * 1024;
    private static final int NAVY = Color.rgb(18, 35, 54), TEAL = Color.rgb(13, 135, 128);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private final List<BluetoothDevice> peers = new ArrayList<>();
    private final List<Source> sources = new ArrayList<>();
    private BluetoothAdapter adapter;
    private Spinner peerSpinner;
    private TextView status, selection, progressText;
    private ProgressBar progress;
    private LinearLayout inbox;
    private Button chooseButton, sendButton, receiveButton, refreshButton, settingsButton, cancelButton;
    private File inboxDir, integrityDir, exportFile;
    private int inboxLimit = 50;
    private volatile BluetoothSocket socket;
    private volatile BluetoothServerSocket listener;
    private volatile boolean busy, cancelled, destroyed, timedOut;
    private volatile long lastActivity, lastUi;
    private volatile CountDownLatch decisionLatch;
    private volatile boolean accepted;
    private AlertDialog incomingDialog;

    private static final class Source {
        final Uri uri; final String name; final long size; final File staged;
        Source(Uri uri, String name, long size, File staged) { this.uri = uri; this.name = name; this.size = size; this.staged = staged; }
    }
    private static final class Entry {
        final String name; final long size;
        Entry(String name, long size) { this.name = name; this.size = size; }
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        BluetoothManager manager = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        adapter = manager == null ? null : manager.getAdapter();
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        inboxDir = new File(base, "bluetooth-inbox");
        inboxDir.mkdirs();
        integrityDir = new File(getFilesDir(), "bluetooth-integrity");
        integrityDir.mkdirs();
        buildUi();
        renderInbox();
        if (adapter == null) setStatus("这台设备没有可用的蓝牙适配器。", true);
        else if (hasPermission()) refreshPeers();
        else setStatus("点击“刷新已配对设备”，允许连接附近的蓝牙设备。", false);
        watchdog.scheduleAtFixedRate(() -> {
            if (busy && socket != null && SystemClock.elapsedRealtime() - lastActivity > 180000) {
                timedOut = true; closeConnections(); releaseDecision();
            }
        }, 15, 15, TimeUnit.SECONDS);
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(28)); root.setBackgroundColor(Color.rgb(244, 247, 250));
                if (Build.VERSION.SDK_INT >= 35) root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(20), dp(24) + insets.getSystemWindowInsetTop(), dp(20), dp(28) + insets.getSystemWindowInsetBottom()); return insets;
        });
        scroll.addView(root); setContentView(scroll);
        TextView title = text("蓝牙离线互传", 27, NAVY); title.setTypeface(null, Typeface.BOLD); root.addView(title);
        TextView subtitle = text("安卓手机 · 安卓平板\n无需 Wi-Fi、流量或互联网", 15, TEAL);
        subtitle.setPadding(0, dp(8), 0, dp(16)); root.addView(subtitle);
        TextView boundary = text("双方都安装 RelayDrop，并在系统蓝牙设置中先配对。此模式仅适用于安卓设备之间；Windows 请使用主页面的系统蓝牙文件传输。\n传输时保持本页打开。支持批量和完整性校验，本版蓝牙不支持断点续传。", 13, Color.rgb(83, 98, 114));
        boundary.setPadding(dp(14), dp(12), dp(14), dp(12)); boundary.setBackground(card(Color.rgb(229, 238, 246))); root.addView(boundary);
        LinearLayout pairing = section(root, "1  连接设备");
        settingsButton = button("打开系统蓝牙设置", pairing, v -> {
            if (busy) return;
            try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); }
            catch (Exception e) { setStatus("无法打开系统设置，请从通知栏进入蓝牙设置。", true); }
        });
        refreshButton = button("刷新已配对设备", pairing, v -> { if (ensureBluetooth()) refreshPeers(); });
        peerSpinner = new Spinner(this); pairing.addView(peerSpinner, new LinearLayout.LayoutParams(-1, dp(52)));
        LinearLayout transfer = section(root, "2  发送或接收");
        chooseButton = button("选择文件（最多 20 个）", transfer, v -> pickFiles());
        selection = text("尚未选择文件", 13, Color.rgb(83, 98, 114)); selection.setPadding(0, dp(8), 0, dp(8)); transfer.addView(selection);
        sendButton = button("发送到所选设备", transfer, v -> startSend());
        receiveButton = button("等待接收", transfer, v -> startReceive());
        status = text("准备就绪", 14, NAVY); status.setPadding(0, dp(16), 0, dp(8)); transfer.addView(status);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); progress.setMax(1000); transfer.addView(progress, new LinearLayout.LayoutParams(-1, dp(14)));
        progressText = text("", 12, Color.rgb(83, 98, 114)); progressText.setPadding(0, dp(6), 0, 0); transfer.addView(progressText);
        cancelButton = button("取消当前操作", transfer, v -> cancelTransfer()); cancelButton.setEnabled(false);
        inbox = section(root, "3  已接收文件");
        TextView retention = text("文件先保存在本应用目录。点击“另存为”保存到下载或其他位置；卸载应用会清除未导出的文件。", 12, Color.rgb(83, 98, 114));
        retention.setPadding(0, dp(14), 0, 0); root.addView(retention);
    }
    private LinearLayout section(LinearLayout root, String heading) {
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(16), dp(16), dp(16), dp(12)); box.setBackground(card(Color.WHITE));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.topMargin = dp(16); root.addView(box, lp);
        TextView title = text(heading, 17, NAVY); title.setTypeface(null, Typeface.BOLD); title.setPadding(0, 0, 0, dp(10)); box.addView(title); return box;
    }
    private TextView text(String value, int sp, int color) { TextView v = new TextView(this); v.setText(value); v.setTextSize(sp); v.setTextColor(color); v.setLineSpacing(dp(3), 1); return v; }
    private GradientDrawable card(int color) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(16)); return d; }
    private int dp(int v) { return Math.round(getResources().getDisplayMetrics().density * v); }
    private Button button(String label, LinearLayout parent, View.OnClickListener click) {
        Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextColor(TEAL); b.setOnClickListener(click);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.topMargin = dp(4); parent.addView(b, lp); return b;
    }
    private void ui(Runnable r) { if (!destroyed) runOnUiThread(() -> { if (!destroyed) r.run(); }); }
    private void setStatus(String message, boolean error) { ui(() -> { status.setText(message); status.setTextColor(error ? Color.rgb(176, 55, 47) : NAVY); }); }
    private void setBusy(boolean value) {
        busy = value;
        ui(() -> { chooseButton.setEnabled(!value); sendButton.setEnabled(!value); receiveButton.setEnabled(!value); refreshButton.setEnabled(!value); settingsButton.setEnabled(!value); peerSpinner.setEnabled(!value); cancelButton.setEnabled(value); });
    }
    private boolean hasPermission() { return Build.VERSION.SDK_INT < 31 || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED; }
    private boolean ensureBluetooth() {
        if (adapter == null) { setStatus("这台设备没有可用的蓝牙适配器。", true); return false; }
        if (!hasPermission()) { requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, PERMISSION_BT); return false; }
        if (!adapter.isEnabled()) {
            try { startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), ENABLE_BT); }
            catch (Exception e) { setStatus("请先在系统设置中打开蓝牙。", true); }
            return false;
        }
        return true;
    }
    private void refreshPeers() {
        if (!hasPermission() || adapter == null) return;
        peers.clear();
        try { peers.addAll(adapter.getBondedDevices()); }
        catch (SecurityException e) { setStatus("蓝牙连接权限被关闭，请重新授权。", true); return; }
        Collections.sort(peers, (a, b) -> deviceName(a).compareToIgnoreCase(deviceName(b)));
        ArrayList<String> labels = new ArrayList<>();
        for (BluetoothDevice d : peers) labels.add(deviceName(d) + " · " + d.getAddress());
        if (labels.isEmpty()) labels.add("尚无已配对设备，请先在系统设置中配对");
        ArrayAdapter<String> list = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels);
        list.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); peerSpinner.setAdapter(list);
        setStatus(peers.isEmpty() ? "先在系统设置中配对另一台安卓设备，再回来刷新。" : "已找到 " + peers.size() + " 台配对设备。接收方请先点“等待接收”。", false);
    }
    private String deviceName(BluetoothDevice d) { try { String name = d.getName(); return name == null || name.trim().isEmpty() ? "蓝牙设备" : name; } catch (SecurityException e) { return "蓝牙设备"; } }
    @Override public void onRequestPermissionsResult(int req, String[] p, int[] grants) {
        super.onRequestPermissionsResult(req, p, grants);
        if (req == PERMISSION_BT) {
            if (hasPermission()) { if (ensureBluetooth()) refreshPeers(); }
            else setStatus("未获得蓝牙连接权限。可在系统的应用权限中允许“附近的设备”。", true);
        }
    }

    private void pickFiles() {
        if (busy) return;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT); i.setType("*/*"); i.addCategory(Intent.CATEGORY_OPENABLE);
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(i, PICK_FILES);
    }
    @Override protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == ENABLE_BT) { if (result == RESULT_OK && hasPermission()) refreshPeers(); return; }
        if (result != RESULT_OK || data == null) { if (req == SAVE_FILE) exportFile = null; return; }
        if (req == SAVE_FILE && data.getData() != null && exportFile != null) {
            File file = exportFile; exportFile = null; exportTo(file, data.getData()); return;
        }
        if (req != PICK_FILES) return;
        ArrayList<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) for (int n = 0; n < data.getClipData().getItemCount(); n++) uris.add(data.getClipData().getItemAt(n).getUri());
        else if (data.getData() != null) uris.add(data.getData());
        if (uris.isEmpty()) return;
        if (uris.size() > MAX_FILES) { setStatus("一次最多选择 20 个文件，请重新选择。", true); return; }
        for (Uri uri : uris) try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
        cancelled = false; timedOut = false; setBusy(true); setStatus("正在读取文件信息…", false);
        worker.execute(() -> {
            ArrayList<Source> prepared = new ArrayList<>();
            try {
                long total = 0;
                for (Uri uri : uris) { checkCancelled(); Source source = inspect(uri); prepared.add(source); total += source.size; if (total > MAX_BATCH) throw new IOException("每批文件总大小不能超过 2 GB。"); }
                checkCancelled(); synchronized (sources) { cleanupSources(); sources.addAll(prepared); }
                StringBuilder info = new StringBuilder(); for (Source s : sources) info.append(s.name).append("  ").append(size(s.size)).append('\n');
                info.append("共 ").append(sources.size()).append(" 个文件 · ").append(size(total));
                ui(() -> selection.setText(info.toString())); setStatus("文件已就绪。确认接收方已点击“等待接收”，再发送。", false);
            } catch (Exception e) { for (Source s : prepared) if (s.staged != null) s.staged.delete(); report(e); }
            finally { setBusy(false); }
        });
    }
    private Source inspect(Uri uri) throws Exception {
        String name = "file"; long length = -1;
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst()) { int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(OpenableColumns.SIZE); if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni); if (si >= 0 && !c.isNull(si)) length = c.getLong(si); }
        }
        name = cleanName(name);
        if (length > MAX_FILE) throw new IOException(name + " 超过单文件 512 MB 上限。");
        File staged = null;
        if (length < 0) {
            staged = File.createTempFile("bt-source-", ".tmp", getCacheDir()); long copied = 0;
            try (InputStream in = openUri(uri); OutputStream out = new FileOutputStream(staged)) {
                byte[] buffer = new byte[BUFFER_SIZE]; int n;
                while ((n = in.read(buffer)) != -1) { checkCancelled(); copied += n; if (copied > MAX_FILE) throw new IOException(name + " 超过单文件 512 MB 上限。"); if (staged.getUsableSpace() < RESERVE) throw new IOException("缓存空间不足。"); out.write(buffer, 0, n); }
                length = copied;
            } catch (Exception e) { staged.delete(); throw e; }
        }
        return new Source(uri, name, length, staged);
    }
    private InputStream openUri(Uri uri) throws IOException { InputStream in = getContentResolver().openInputStream(uri); if (in == null) throw new IOException("无法读取所选文件，请重新选择。"); return in; }
    private InputStream openSource(Source s) throws IOException { return s.staged == null ? openUri(s.uri) : new FileInputStream(s.staged); }
    private static String cleanName(String name) {
        if (name == null) name = "file";
        name = name.replaceAll("[\\x00-\\x1f\\x7f/\\\\:*?\"<>|]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "file";
                while (name.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 180) {
            int last = name.offsetByCodePoints(name.length(), -1); name = name.substring(0, last);
        }
        return name;
    }
        private static boolean validName(String name) {
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..") || name.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 180) return false;
        for (int i = 0; i < name.length(); i++) { char ch = name.charAt(i); if (ch < 32 || ch == 127 || ch == '/' || ch == '\\') return false; }
        return true;
    }
    private static String size(long bytes) { if (bytes < 1024) return bytes + " B"; if (bytes < 1048576) return String.format(Locale.US, "%.1f KB", bytes / 1024.0); if (bytes < 1073741824) return String.format(Locale.US, "%.1f MB", bytes / 1048576.0); return String.format(Locale.US, "%.2f GB", bytes / 1073741824.0); }

    private void startSend() {
        if (busy || !ensureBluetooth()) return;
        if (sources.isEmpty()) { setStatus("请先选择要发送的文件。", true); return; }
        int selected = peerSpinner.getSelectedItemPosition();
        if (selected < 0 || selected >= peers.size()) { setStatus("请先配对设备并刷新列表。", true); return; }
        BluetoothDevice target = peers.get(selected); ArrayList<Source> batch = new ArrayList<>(sources);
        cancelled = false; timedOut = false; lastActivity = SystemClock.elapsedRealtime(); setBusy(true); progress.setProgress(0);
        setStatus("正在连接 " + deviceName(target) + "…", false);
        worker.execute(() -> {
            try {
                ArrayList<FileIntegrity.Value> sourceHashes = new ArrayList<>();
                for (Source source : batch) {
                    setStatus("正在校验发送源文件：" + source.name, false);
                    try (InputStream input = openSource(source)) { sourceHashes.add(FileIntegrity.read(input, source.size, this::checkCancelled)); }
                }
                if (target.getBondState() != BluetoothDevice.BOND_BONDED) throw new IOException("设备配对已失效，请在系统设置中重新配对。");
                socket = target.createRfcommSocketToServiceRecord(SERVICE_UUID); checkCancelled(); socket.connect(); touch();
                try (DataOutputStream out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), BUFFER_SIZE)); DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), BUFFER_SIZE))) {
                    long total = 0; out.writeUTF(MAGIC); out.writeInt(batch.size());
                    for (Source s : batch) { out.writeUTF(s.name); out.writeLong(s.size); total += s.size; }
                    out.flush(); setStatus("已连接，等待对方确认这批文件…", false);
                    boolean allow = in.readBoolean(); String reason = in.readUTF(); touch();
                    if (!allow) throw new IOException(reason.isEmpty() ? "对方拒绝了本批文件。" : reason);
                    long done = 0; int index = 0;
                    for (Source s : batch) {
                        checkCancelled(); index++; MessageDigest digest = MessageDigest.getInstance("SHA-256");
                        setStatus("正在发送 " + index + "/" + batch.size() + "：" + s.name, false);
                        try (InputStream file = new BufferedInputStream(openSource(s), BUFFER_SIZE)) {
                            long remaining = s.size; byte[] buffer = new byte[BUFFER_SIZE];
                            while (remaining > 0) { checkCancelled(); int n = file.read(buffer, 0, (int) Math.min(buffer.length, remaining)); if (n < 0) throw new IOException("源文件已变化，请重新选择：" + s.name); if (n == 0) continue; out.write(buffer, 0, n); digest.update(buffer, 0, n); remaining -= n; done += n; touch(); showProgress(done, total, false); }
                            if (file.read() != -1) throw new IOException("源文件大小已变化，请重新选择：" + s.name);
                        }
                        FileIntegrity.Value expected = sourceHashes.get(index - 1);
                        try { FileIntegrity.require(new FileIntegrity.Value(s.size, digest.digest()), expected); }
                        catch (FileIntegrity.Mismatch e) { throw new IOException("源文件内容在校验后发生变化，已停止发送：" + s.name, e); }
                        out.write(expected.sha256); out.flush(); setStatus("等待对方读回校验：" + s.name, false);
                        boolean valid = in.readBoolean(); String message = in.readUTF(); touch();
                        if (!valid) throw new IOException(message.isEmpty() ? "接收方校验失败。" : message);
                    }
                    showProgress(total, total, true); setStatus("发送完成：" + batch.size() + " 个文件均已被对方接收并通过 SHA-256 校验。", false);
                }
            } catch (Exception e) { report(e); }
            finally { closeConnections(); setBusy(false); }
        });
    }

    private void startReceive() {
        if (busy || !ensureBluetooth()) return;
        cancelled = false; timedOut = false; lastActivity = SystemClock.elapsedRealtime(); setBusy(true); progress.setProgress(0);
        setStatus("正在等待已配对的安卓设备连接。请让发送方选择本机并发送。", false);
        worker.execute(() -> {
            File partial = null;
            try {
                listener = adapter.listenUsingRfcommWithServiceRecord("RelayDrop", SERVICE_UUID); checkCancelled();
                socket = listener.accept(); touch(); listener.close(); listener = null; checkCancelled();
                if (socket.getRemoteDevice().getBondState() != BluetoothDevice.BOND_BONDED) throw new IOException("拒绝未配对设备，请先在系统设置中配对。");
                try (DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), BUFFER_SIZE)); DataOutputStream out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), BUFFER_SIZE))) {
                    if (!MAGIC.equals(in.readUTF())) throw new IOException("对方使用了不兼容的传输协议。");
                    int count = in.readInt(); if (count < 1 || count > MAX_FILES) throw new IOException("对方的文件数量无效。");
                    ArrayList<Entry> entries = new ArrayList<>(); long total = 0;
                    for (int n = 0; n < count; n++) {
                        String name = in.readUTF(); long length = in.readLong(); touch();
                        if (!validName(name) || length < 0 || length > MAX_FILE) throw new IOException("对方的文件名或大小不符合要求。");
                        total += length; if (total > MAX_BATCH) throw new IOException("这批文件超过 2 GB 上限。"); entries.add(new Entry(name, length));
                    }
                    if (!inboxDir.isDirectory() && !inboxDir.mkdirs()) throw new IOException("无法创建接收目录。");
                    if (inboxDir.getUsableSpace() < total + RESERVE) { out.writeBoolean(false); out.writeUTF("接收方存储空间不足。"); out.flush(); throw new IOException("存储空间不足，请释放空间后重新接收。"); }
                    boolean approve = confirmIncoming(deviceName(socket.getRemoteDevice()) + " · " + socket.getRemoteDevice().getAddress(), entries, total);
                    out.writeBoolean(approve); out.writeUTF(approve ? "可以发送" : "接收方已拒绝或未及时确认。"); out.flush(); touch();
                    if (!approve) { setStatus("已拒绝本批文件，没有接收内容。", false); return; }
                    long done = 0; int index = 0;
                    for (Entry entry : entries) {
                        checkCancelled(); index++; setStatus("正在接收 " + index + "/" + count + "：" + entry.name, false);
                        if (inboxDir.getUsableSpace() < entry.size + RESERVE) throw new IOException("存储空间不足，传输已停止。");
                        String id = UUID.randomUUID().toString(); partial = new File(inboxDir, id + ".part"); File ready = new File(inboxDir, id + "-" + entry.name);
                        if (!ready.getCanonicalFile().getParentFile().equals(inboxDir.getCanonicalFile())) throw new IOException("文件路径无效。");
                        MessageDigest digest = MessageDigest.getInstance("SHA-256");
                        try (FileOutputStream file = new FileOutputStream(partial)) {
                            long remaining = entry.size; byte[] buffer = new byte[BUFFER_SIZE];
                            while (remaining > 0) { checkCancelled(); int n = in.read(buffer, 0, (int) Math.min(buffer.length, remaining)); if (n < 0) throw new IOException("连接中断，未完成的文件已丢弃。"); if (n == 0) continue; file.write(buffer, 0, n); digest.update(buffer, 0, n); remaining -= n; done += n; touch(); showProgress(done, total, false); }
                            file.flush(); file.getFD().sync();
                        }
                        byte[] expected = new byte[32]; in.readFully(expected); touch();
                        if (!MessageDigest.isEqual(expected, digest.digest())) { partial.delete(); partial = null; out.writeBoolean(false); out.writeUTF("SHA-256 校验失败，文件已丢弃。"); out.flush(); throw new IOException("文件完整性校验失败，请重新发送。"); }
                        setStatus("正在读回接收文件并校验：" + entry.name, false);
                        FileIntegrity.Value verified = new FileIntegrity.Value(entry.size, expected);
                        try (InputStream saved = new FileInputStream(partial)) {
                            FileIntegrity.require(FileIntegrity.read(saved, entry.size, () -> { checkCancelled(); touch(); }), verified);
                        }
                        // Persist the original digest before publication; an orphan record is harmless.
                        saveIntegrity(ready, verified, true);
                        if (!partial.renameTo(ready)) { integrityFile(ready).delete(); throw new IOException("无法保存已接收文件，请检查存储空间。"); }
                        partial = null;
                        out.writeBoolean(true); out.writeUTF("已保存并校验"); out.flush(); touch(); ui(this::renderInbox);
                    }
                    showProgress(total, total, true); setStatus("接收完成：" + count + " 个文件均已通过校验。可在下方另存为。", false);
                }
            } catch (Exception e) { report(e); }
            finally { if (partial != null) partial.delete(); closeConnections(); releaseDecision(); setBusy(false); ui(this::renderInbox); }
        });
    }
    private boolean confirmIncoming(String peer, List<Entry> entries, long total) throws InterruptedException {
        accepted = false; CountDownLatch gate = new CountDownLatch(1); decisionLatch = gate;
        StringBuilder summary = new StringBuilder(peer).append(" 想发送 ").append(entries.size()).append(" 个文件，共 ").append(size(total)).append("：\n\n");
        for (Entry e : entries) summary.append(e.name).append("  ").append(size(e.size)).append('\n');
        ui(() -> {
            if (cancelled) { gate.countDown(); return; }
            incomingDialog = new AlertDialog.Builder(this).setTitle("是否接收这批文件？").setMessage(summary.toString()).setPositiveButton("接收", (d, which) -> { accepted = true; gate.countDown(); }).setNegativeButton("拒绝", (d, which) -> gate.countDown()).setOnCancelListener(d -> gate.countDown()).create();
            incomingDialog.show();
        });
        boolean answered = gate.await(120, TimeUnit.SECONDS); decisionLatch = null;
        ui(() -> { if (incomingDialog != null) { incomingDialog.dismiss(); incomingDialog = null; } });
        return answered && accepted && !cancelled;
    }
    private void touch() { lastActivity = SystemClock.elapsedRealtime(); }
    private void showProgress(long done, long total, boolean force) {
        long time = SystemClock.elapsedRealtime(); if (!force && time - lastUi < 150) return; lastUi = time;
        int value = total == 0 ? (force ? 1000 : 0) : (int) Math.min(1000, done * 1000 / total);
        ui(() -> { progress.setProgress(value); progressText.setText(size(done) + " / " + size(total) + (force ? " · 已确认完成" : "")); });
    }
    private void checkCancelled() throws IOException { if (cancelled || destroyed || Thread.currentThread().isInterrupted()) throw new IOException("已取消"); if (timedOut) throw new IOException("连接超时"); }
    private void report(Exception e) {
        if (destroyed) return;
        if (cancelled) setStatus("操作已取消。已完成的接收文件保留；未完成文件需重新发送。", false);
        else if (timedOut) setStatus("连接长时间没有响应，已停止。请保持双方页面打开后重试。", true);
        else { String message = e.getMessage(); if (message == null || message.trim().isEmpty()) message = e.getClass().getSimpleName(); if (message.length() > 240) message = message.substring(0, 240); setStatus("操作未完成：" + message + "\n请检查双方蓝牙、配对状态和接收页面后重试。", true); }
    }
    private void closeConnections() { BluetoothSocket active = socket; socket = null; if (active != null) try { active.close(); } catch (IOException ignored) { } BluetoothServerSocket waiting = listener; listener = null; if (waiting != null) try { waiting.close(); } catch (IOException ignored) { } }
    private void releaseDecision() { CountDownLatch gate = decisionLatch; if (gate != null) gate.countDown(); ui(() -> { if (incomingDialog != null) { incomingDialog.dismiss(); incomingDialog = null; } }); }
        private void closeConnectionsAsync() {
        final BluetoothSocket active = socket; socket = null;
        final BluetoothServerSocket waiting = listener; listener = null;
        Thread closer = new Thread(() -> {
            if (active != null) try { active.close(); } catch (IOException ignored) { }
            if (waiting != null) try { waiting.close(); } catch (IOException ignored) { }
        }, "RelayDrop-BT-close"); closer.setDaemon(true); closer.start();
    }
    private void cancelTransfer() { if (!busy) return; cancelled = true; closeConnectionsAsync(); releaseDecision(); setStatus("正在取消…", false); }
    private void cleanupSources() { synchronized (sources) { for (Source s : sources) if (s.staged != null) s.staged.delete(); sources.clear(); } }

    private void renderInbox() {
        while (inbox.getChildCount() > 1) inbox.removeViewAt(1);
        File[] files = inboxDir.listFiles(f -> f.isFile() && !f.getName().endsWith(".part") && f.getName().length() > 37);
        if (files == null || files.length == 0) { TextView empty = text("接收完成的文件会显示在这里。", 13, Color.rgb(83, 98, 114)); inbox.addView(empty); return; }
        Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        for (int i = 0; i < Math.min(files.length, inboxLimit); i++) {
            File file = files[i]; String name = file.getName().substring(37);
            TextView item = text(name + "\n" + size(file.length()), 14, NAVY); item.setPadding(0, dp(12), 0, 0); inbox.addView(item);
            button("另存为", inbox, v -> {
                if (busy) { Toast.makeText(this, "请等待当前操作结束后再导出。", Toast.LENGTH_SHORT).show(); return; }
                exportFile = file; Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT); save.addCategory(Intent.CATEGORY_OPENABLE);
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext); save.setType(mime == null ? "application/octet-stream" : mime); save.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(save, SAVE_FILE); } catch (Exception e) { exportFile = null; setStatus("无法打开系统保存窗口。", true); }
            });
        }
        if (files.length > inboxLimit) button("显示更多已接收文件", inbox, v -> { inboxLimit += 50; renderInbox(); });
    }
    private static final class IntegrityRecord {
        final FileIntegrity.Value value; final boolean received;
        IntegrityRecord(FileIntegrity.Value value, boolean received) { this.value = value; this.received = received; }
    }
    private File integrityFile(File source) throws IOException {
        String name = source.getName();
        if (name.length() < 37 || !name.substring(0, 36).matches("[a-fA-F0-9-]{36}")) throw new IOException("接收文件标识无效。");
        return new File(integrityDir, name.substring(0, 36) + ".sha256");
    }
    private void saveIntegrity(File source, FileIntegrity.Value value, boolean received) throws IOException {
        if (!integrityDir.isDirectory() && !integrityDir.mkdirs()) throw new IOException("无法保存接收校验记录。");
        AtomicFile atomic = new AtomicFile(integrityFile(source)); FileOutputStream output = null;
        try {
            output = atomic.startWrite();
            String record = "RelayDrop-integrity-1\n" + value.size + "\n" + FileIntegrity.hex(value.sha256) + "\n" + (received ? "received" : "current") + "\n";
            output.write(record.getBytes(java.nio.charset.StandardCharsets.US_ASCII)); output.flush(); output.getFD().sync();
            atomic.finishWrite(output); output = null;
        } finally { if (output != null) atomic.failWrite(output); }
        IntegrityRecord stored = loadIntegrity(source);
        if (stored == null || stored.received != received) throw new IOException("接收校验记录未可靠保存。");
        FileIntegrity.require(stored.value, value);
    }
    private IntegrityRecord loadIntegrity(File source) throws IOException {
        File file = integrityFile(source); AtomicFile atomic = new AtomicFile(file);
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) return null;
        try (InputStream input = atomic.openRead()) {
            byte[] record = new byte[256]; int count = 0, n;
            while ((n = input.read(record, count, record.length - count)) > 0) { count += n; if (count == record.length) throw new IOException("接收校验记录过长。"); }
            String[] fields = new String(record, 0, count, java.nio.charset.StandardCharsets.US_ASCII).split("\n");
            if (fields.length != 4 || !fields[0].equals("RelayDrop-integrity-1") || (!fields[3].equals("received") && !fields[3].equals("current"))) throw new IOException("接收校验记录损坏，请重新接收。");
            long length;
            try { length = Long.parseLong(fields[1]); } catch (NumberFormatException e) { throw new IOException("接收校验记录中的大小无效。", e); }
            if (length < 0 || length > MAX_FILE) throw new IOException("接收校验记录中的大小无效。");
            return new IntegrityRecord(new FileIntegrity.Value(length, FileIntegrity.fromHex(fields[2])), fields[3].equals("received"));
        }
    }
    private void exportTo(File source, Uri destination) {
        if (busy) return;
        cancelled = false; timedOut = false; setBusy(true); setStatus("正在校验已接收源文件…", false);
        worker.execute(() -> {
            boolean complete = false; String error = null;
            SafDocumentCleanup cleanup = new SafDocumentCleanup(getContentResolver(), destination);
            try {
                IntegrityRecord record = loadIntegrity(source);
                long expectedSize = record == null ? source.length() : record.value.size;
                FileIntegrity.Value actualSource;
                try (InputStream input = new FileInputStream(source)) { actualSource = FileIntegrity.read(input, expectedSize, this::checkCancelled); }
                if (record == null) { record = new IntegrityRecord(actualSource, false); saveIntegrity(source, actualSource, false); }
                else FileIntegrity.require(actualSource, record.value);
                final boolean originalReceipt = record.received; FileIntegrity.Value expected = record.value;
                setStatus(originalReceipt ? "源文件与接收时的校验值一致，正在另存…" : "旧接收文件没有原始校验记录；正在按本次源内容另存并校验。", false);
                MessageDigest digest = FileIntegrity.digest(); long copied = 0;
                try (InputStream input = new FileInputStream(source); OutputStream output = cleanup.open("wt")) {
                    byte[] buffer = new byte[BUFFER_SIZE]; int n;
                    while ((n = input.read(buffer)) != -1) { checkCancelled(); if (n > expected.size - copied) throw new IOException("源文件大小发生变化。"); output.write(buffer, 0, n); digest.update(buffer, 0, n); copied += n; }
                    output.flush();
                }
                FileIntegrity.require(new FileIntegrity.Value(copied, digest.digest()), expected);
                setStatus("正在读回另存目标并核验完整内容…", false);
                cleanup.verifySaved(expected, this::checkCancelled); checkCancelled(); complete = true;
                setStatus("文件已另存，并通过目标读回校验。" + (originalReceipt ? "" : "\n旧文件仅确认与本次源内容一致，无法追溯最初接收时的内容。"), false);
            } catch (Exception e) { error = cancelled ? "另存已取消。" : "另存未完成：" + (!source.isFile() ? "源接收文件已不可用。" : e.getMessage() == null ? "无法读取或写入文件。" : e.getMessage()); }
            if (!complete) {
                if (!cleanup.deleteIncomplete()) error += "\n未能安全移除未完成文件，请在刚才选择的保存位置手动删除：" + cleanup.displayName(source.getName().substring(37));
                setStatus(error + (source.isFile() ? "\n原接收文件仍保留在本应用中。" : "\n源接收文件已不可用，请重新接收。"), true);
            }
            cleanup.close(); setBusy(false); ui(this::renderInbox);
        });
    }
    @Override public void onBackPressed() {
        if (!busy) { super.onBackPressed(); return; }
        new AlertDialog.Builder(this).setTitle("停止当前操作并返回？").setMessage("未完成的蓝牙文件需要重新发送。已接收完成的文件会保留。").setPositiveButton("停止并返回", (d, w) -> { cancelTransfer(); finish(); }).setNegativeButton("继续传输", null).show();
    }
    @Override protected void onDestroy() {
        destroyed = true; cancelled = true; closeConnectionsAsync(); CountDownLatch gate = decisionLatch; if (gate != null) gate.countDown();
        worker.shutdownNow(); watchdog.shutdownNow(); cleanupSources(); super.onDestroy();
    }
}


