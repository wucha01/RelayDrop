package app.relaydrop;

import android.content.Context;
import android.os.Build;
import android.util.AtomicFile;
import android.util.Base64;
import fi.iki.elonen.NanoHTTPD;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.regex.*;

/** Local-only, resumable HTTP relay. Uses exactly the desktop client's wire protocol. */
public final class RelayHttpServer extends BoundedHttpServer {
    private static final int CHUNK = 1024 * 1024;
    private static final long MAX_FILE = 20L * 1024 * 1024 * 1024;
    private final Context context;
    private final int requestedPort;
    private final File directory, partials, files;
    private final AtomicFile stateFile;
    private final Object mutex = new Object();
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Ticket> tickets = new HashMap<>();
    private final Set<String> finalizing = new HashSet<>();
    private final Map<String, List<Long>> attempts = new HashMap<>();
    private final List<Long> globalAttempts = new ArrayList<>();
    private JSONObject state;
    private String committedState;
    private String hostToken;
    private volatile boolean sharingPaused;
    private final Map<String,Set<Closeable>> requests=new HashMap<>();
    private final Map<String,Set<RevocableStream>> streams=new HashMap<>();
    private final java.util.concurrent.ConcurrentHashMap<Integer,String> remotePeers=new java.util.concurrent.ConcurrentHashMap<>();
    void registerRemotePeer(int port,String peer){if(port>0&&port<=65535&&remotePeers.size()<256&&peer!=null&&peer.matches("[a-f0-9]{64}"))remotePeers.put(port,peer);}
    void unregisterRemotePeer(int port){remotePeers.remove(port);}
    private String pairingPeer(IHTTPSession s){if(!Boolean.TRUE.equals(remoteRequest.get()))return s.getRemoteIpAddress();int port=BoundedHttpServer.remotePort();String peer=remotePeers.get(port);return peer==null?"remote-socket:"+port:"remote-session:"+peer;}
    boolean isSharingPaused(){return sharingPaused;}
    void setSharingPaused(boolean paused)throws Exception {synchronized(mutex){state.put("sharingPaused",paused);persist();sharingPaused=paused;if(paused){for(Set<RevocableStream> values:new ArrayList<>(streams.values()))for(RevocableStream stream:new ArrayList<>(values))if(!stream.local)stream.abort();disconnectClients();if(remoteTls instanceof BoundedHttpServer)((BoundedHttpServer)remoteTls).disconnectClients();}}if(paused)RemoteManager.stopHost();RelayService.sharingChanged(this,paused);}
    private void revokeActive(String id){Set<Closeable> active=requests.get(id);if(active!=null)for(Closeable socket:new ArrayList<>(active))try{socket.close();}catch(IOException ignored){}Set<RevocableStream> values=streams.get(id);if(values!=null)for(RevocableStream stream:new ArrayList<>(values))stream.abort();tickets.entrySet().removeIf(e->id.equals(e.getValue().device));}
    private final class RevocableStream extends FilterInputStream {final String device;final boolean local;final Closeable socket;boolean closed;RevocableStream(InputStream in,String device){super(in);this.device=device;local=Boolean.TRUE.equals(localRequest.get());socket=BoundedHttpServer.currentSocket();streams.computeIfAbsent(device,k->new HashSet<>()).add(this);}private void check()throws IOException{synchronized(mutex){try{JSONObject d=byId("devices",device);if(closed||d==null||d.optBoolean("revoked")||sharingPaused&&!local)throw new IOException("Device access revoked");}catch(JSONException e){throw new IOException(e);}}BoundedHttpServer.streamProgress();}public int read()throws IOException{check();return in.read();}public int read(byte[] b,int o,int n)throws IOException{check();return in.read(b,o,Math.min(n,65536));}void abort(){try{close();}catch(IOException ignored){}if(socket!=null)try{socket.close();}catch(IOException ignored){}}public void close()throws IOException{synchronized(mutex){if(closed)return;closed=true;Set<RevocableStream> active=streams.get(device);if(active!=null){active.remove(this);if(active.isEmpty())streams.remove(device);}}super.close();}}
    private long lastSeenSave;
    private final ImagePreviews previews=new ImagePreviews();
    private final PreviewIntegrity previewIntegrity=new PreviewIntegrity();
    private boolean storageBusy,storageRecoveryRequired;
    private final java.util.concurrent.atomic.AtomicInteger pendingPreviews=new java.util.concurrent.atomic.AtomicInteger();
    private TlsIdentity identity;
    private NanoHTTPD localUi;
    private NanoHTTPD remoteTls;
    private final ThreadLocal<Boolean> localRequest=new ThreadLocal<>();
    private final ThreadLocal<Boolean> remoteRequest=new ThreadLocal<>();
    void enableTls(TlsIdentity value){identity=value;makeSecure(value.socketFactory,TlsIdentity.protocols());}
    void startLocalUi()throws IOException{localUi=new BoundedHttpServer("127.0.0.1",0,24,24){@Override public Response serve(IHTTPSession s){localRequest.set(Boolean.TRUE);try{return RelayHttpServer.this.serve(s);}finally{localRequest.remove();}}};localUi.start(120000,false);}
    int getLocalPort(){return localUi==null?getPort():localUi.getListeningPort();}
    TlsIdentity identity(){return identity;}
    synchronized int startRemoteTls()throws IOException{if(identity==null)throw new IOException("TLS identity unavailable");if(remoteTls!=null)return remoteTls.getListeningPort();NanoHTTPD endpoint=new BoundedHttpServer("127.0.0.1",0,24,24){@Override public Response serve(IHTTPSession s){remoteRequest.set(Boolean.TRUE);try{return RelayHttpServer.this.serve(s);}finally{remoteRequest.remove();}}};endpoint.makeSecure(identity.socketFactory,TlsIdentity.protocols());endpoint.start(120000,false);remoteTls=endpoint;return endpoint.getListeningPort();}
    synchronized void stopRemoteTls(){if(remoteTls!=null){remoteTls.stop();remoteTls=null;}}
    @Override public void stop(){stopRemoteTls();if(localUi!=null)localUi.stop();super.stop();remotePeers.clear();}

    public RelayHttpServer(Context context, int port) throws IOException {
        super(port);
        if(PoolBackup.BUSY.get())throw new IOException("文件池正在备份或恢复，请等待完成后再启动。");
        this.context = context.getApplicationContext();
        this.requestedPort = port;
        directory = new File(context.getFilesDir(), "relaydrop");
        partials = new File(directory, "partials"); files = new File(directory, "files");
        if ((!partials.isDirectory() && !partials.mkdirs()) || (!files.isDirectory() && !files.mkdirs())) throw new IOException("无法创建中转站存储目录。");
        stateFile = new AtomicFile(new File(directory, "state.json"));
        try {
            if (stateFile.getBaseFile().exists() || new File(stateFile.getBaseFile().getPath() + ".bak").exists()) {
                try (InputStream in = stateFile.openRead()) { state = new JSONObject(new String(readAll(in, 32 * 1024 * 1024), StandardCharsets.UTF_8)); }
                if (state.optInt("version") != 1 || !state.has("hostToken") || !state.has("devices") || !state.has("transfers") || !state.has("files") || !state.has("notes")) throw new IOException("中转站数据格式异常，现有数据未被修改。");
            } else {
                state = object("version", 1, "hostToken", randomToken(), "devices", new JSONArray(), "transfers", new JSONArray(), "files", new JSONArray(), "notes", new JSONArray());
                state.getJSONArray("devices").put(object("id", "host", "name", Build.MODEL, "role", "host", "revoked", false, "lastSeen", iso()));
            }
            SharedFolders.all(state);
            try{SharedFolders.validateTree(state);}catch(Exception error){throw new IOException("共享目录清单异常，现有数据已保留。",error);}
            committedState = state.toString();
            hostToken = state.getString("hostToken");
            sharingPaused=state.optBoolean("sharingPaused");
            recoverImport();
            recoverDeletes();
            JSONArray transfers = array("transfers");
            for (int i = 0; i < transfers.length(); i++) {
                JSONObject t = transfers.getJSONObject(i);
                if ("complete".equals(t.optString("status"))) continue;
                File partial = part(t.getString("id")), ready = ready(t.getString("id"));
                long size = partial.exists() ? partial.length() : ready.exists() ? ready.length() : 0;
                if (size > t.getLong("size")) throw new IOException("部分文件大小异常，已保留数据并停止启动。");
                if (!partial.exists() && !ready.exists() && !partial.createNewFile()) throw new IOException("无法恢复传输任务。");
                t.put("offset", size); t.put("status", "uploading");
            }
            JSONObject pairing = state.optJSONObject("pairing");
            if (pairing == null || pairing.optLong("expiresEpoch") <= System.currentTimeMillis()) rotatePairing();
            else persist();
        } catch (JSONException error) { throw new IOException("中转站数据损坏，现有文件已保留。", error); }
    }

    public String getHostToken() { return hostToken; }
    public int getPort() { int live = getListeningPort(); return live > 0 ? live : requestedPort; }
    public String getLocalUrl() { return "http://127.0.0.1:" + getLocalPort() + "/#host=" + hostToken; }
    public File getDataDirectory() { return directory; }
    JSONObject beginStorageOperation()throws Exception{synchronized(mutex){if(storageRecoveryRequired)throw new IOException("上次恢复提交结果需要重新启动文件池确认，原件已保留，请勿重复导入。");if(storageBusy||!finalizing.isEmpty())throw new IOException("文件正在校验或已有备份任务，请稍后重试。");storageBusy=true;return new JSONObject(state.toString());}}
    void endStorageOperation(){synchronized(mutex){storageBusy=false;}}
    File backupOriginal(String id)throws IOException{if(id==null||!id.matches("[a-fA-F0-9-]{36}"))throw new IOException("备份文件编号无效。");return ready(id);}
    private void recoverImport()throws IOException,JSONException{File journal=new File(directory,"import-pending.json");if(!journal.isFile())return;JSONObject doc;try(InputStream in=new FileInputStream(journal)){doc=new JSONObject(new String(readAll(in,4*1024*1024),StandardCharsets.UTF_8));}JSONArray ids=doc.getJSONArray("files");for(int i=0;i<ids.length();i++){String id=ids.getString(i);if(!id.matches("[a-fA-F0-9-]{36}"))throw new IOException("恢复日志无效，文件已保留。");if(byId("files",id)==null)delete(ready(id));}delete(journal);}
    private String restoredFolder(JSONObject source,JSONObject destination,String id,String root,Map<String,String> mapped)throws Exception{if(id==null)return root;if(mapped.containsKey(id))return mapped.get(id);JSONObject folder=SharedFolders.find(source,id);String parent=restoredFolder(source,destination,SharedFolders.nullable(folder,"parentId"),root,mapped);String result=SharedFolders.ensure(destination,parent,new JSONArray().put(folder.getString("name")),"host",iso()).getString("folderId");mapped.put(id,result);return result;}
    interface BackupWriter {void write(JSONObject original,File destination)throws Exception;}
    JSONObject importVerifiedBackup(JSONObject manifest,File staged)throws Exception{return importVerifiedBackup(manifest,(original,destination)->{File source=new File(staged,original.getString("id"));if(!source.isFile()||source.length()!=original.getLong("size")||!source.renameTo(destination))throw new IOException("恢复暂存原件保存失败。");});}
    JSONObject importVerifiedBackup(JSONObject manifest,BackupWriter writer)throws Exception {
      final JSONObject candidate,result;final JSONArray inputs;final List<File> destinations=new ArrayList<>();final String priorFiles,priorFolders,priorNotes;final File journal=new File(directory,"import-pending.json");
      // Plan metadata and a recoverable destination journal under the short state lock.
      synchronized(mutex){
        if(!storageBusy||storageRecoveryRequired)throw new IOException("恢复存储锁已失效。");
        JSONObject incoming=new JSONObject(manifest.toString());PoolBackup.validate(incoming);
        priorFiles=state.getJSONArray("files").toString();priorFolders=state.getJSONArray("folders").toString();priorNotes=state.getJSONArray("notes").toString();
        JSONObject planned=new JSONObject(state.toString());inputs=incoming.getJSONArray("files");JSONArray sourceFolders=incoming.getJSONArray("folders"),sourceNotes=incoming.getJSONArray("notes"),moved=new JSONArray();
        if(planned.getJSONArray("files").length()+inputs.length()>50000||planned.getJSONArray("notes").length()+sourceNotes.length()>5000)throw new IOException("恢复后文件不得超过 50,000 项，文字不得超过 5,000 条。");
        String rootName="恢复的文件池-"+new SimpleDateFormat("yyyyMMdd-HHmmss",Locale.US).format(new Date())+"-"+UUID.randomUUID().toString().substring(0,6);boolean mergedPaths=false;String root=null;Map<String,String> mapped=new HashMap<>();JSONObject source=new JSONObject().put("folders",sourceFolders);
        try{root=SharedFolders.ensure(planned,null,new JSONArray().put(rootName),"host",iso()).getString("folderId");for(int i=0;i<sourceFolders.length();i++)restoredFolder(source,planned,sourceFolders.getJSONObject(i).getString("id"),root,mapped);}
        catch(IOException boundary){mergedPaths=true;planned=new JSONObject(state.toString());mapped.clear();root=null;for(int i=0;i<sourceFolders.length();i++)restoredFolder(source,planned,sourceFolders.getJSONObject(i).getString("id"),null,mapped);}
        JSONArray newFiles=planned.getJSONArray("files");
        for(int i=0;i<inputs.length();i++){JSONObject f=inputs.getJSONObject(i);String id=UUID.randomUUID().toString();boolean shared="shared".equals(f.getString("visibility"));JSONObject copy=object("id",id,"name",f.getString("name"),"size",f.getLong("size"),"sha256",f.getString("sha256"),"mime",f.optString("mime","application/octet-stream"),"createdAt",f.optString("createdAt",iso()),"lastModified",f.optLong("lastModified"),"senderId","host","senderName",Build.MODEL,"targetId",shared?null:"host","folderId",shared?restoredFolder(source,planned,SharedFolders.nullable(f,"folderId"),root,mapped):null);if(!f.isNull("deletedAt"))copy.put("deletedAt",f.getString("deletedAt")).put("deletedBy","host");newFiles.put(copy);moved.put(id);destinations.add(ready(id));}
        JSONArray notes=planned.getJSONArray("notes");for(int i=0;i<sourceNotes.length();i++){JSONObject n=sourceNotes.getJSONObject(i);notes.put(object("id",UUID.randomUUID().toString(),"text",n.getString("text"),"createdAt",n.optString("createdAt",iso()),"senderId","host","senderName",Build.MODEL,"targetId","shared".equals(n.getString("visibility"))?null:"host"));}SharedFolders.validateTree(planned);candidate=planned;
        result=object("files",inputs.length(),"folders",sourceFolders.length(),"notes",sourceNotes.length(),"folderId",root,"rootFolderId",root,"mergedPaths",mergedPaths,"folderName",mergedPaths?"按原路径合并（原件不覆盖）":rootName);
        if(journal.exists())throw new IOException("上次恢复日志需要重启处理。");byte[] data=object("files",moved).toString().getBytes(StandardCharsets.UTF_8);if(data.length>4*1024*1024)throw new IOException("恢复日志超过限制。");
        File temporary=new File(directory,"import-pending-"+UUID.randomUUID()+".tmp");
        try{try(FileOutputStream out=new FileOutputStream(temporary)){out.write(data);out.getFD().sync();}try(InputStream in=new FileInputStream(temporary)){if(!Arrays.equals(data,readAll(in,4*1024*1024)))throw new IOException("恢复日志写入校验失败。");}if(journal.exists()||!temporary.renameTo(journal))throw new IOException("无法发布恢复日志。");}
        finally{if(temporary.exists())temporary.delete();}
      }
      boolean committing=false;
      try{
        // Crypto / SAF reads may take minutes; never hold the server state lock here.
        // The storage gate keeps the file tree stable while pause and permission changes remain responsive.
        for(int i=0;i<destinations.size();i++){File destination=destinations.get(i);if(destination.exists())throw new IOException("恢复目标已存在。");writer.write(inputs.getJSONObject(i),destination);if(!destination.isFile()||destination.length()!=inputs.getJSONObject(i).getLong("size"))throw new IOException("恢复原件保存失败。");}
        synchronized(mutex){
          if(!storageBusy||storageRecoveryRequired||!priorFiles.equals(state.getJSONArray("files").toString())||!priorFolders.equals(state.getJSONArray("folders").toString())||!priorNotes.equals(state.getJSONArray("notes").toString()))throw new IOException("文件池内容在恢复期间发生变化，未提交恢复。");
          // Preserve the latest device revocations, pairing code, sharing pause and all other runtime settings.
          JSONObject latest=new JSONObject(state.toString());latest.put("files",candidate.getJSONArray("files")).put("folders",candidate.getJSONArray("folders")).put("notes",candidate.getJSONArray("notes"));
          committing=true;state=latest;persist();journal.delete();
        }
        return result;
      }catch(Exception error){synchronized(mutex){if(committing){storageRecoveryRequired=true;throw new IOException("恢复提交结果需要重新启动文件池确认，原件及恢复日志已保留，请勿重复导入。",error);}recoverImport();}throw error;}
    }

    private static JSONObject object(Object... pairs) throws JSONException {
        JSONObject value = new JSONObject();
        for (int i = 0; i < pairs.length; i += 2) value.put((String) pairs[i], pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]);
        return value;
    }
    private JSONArray array(String name) throws JSONException { return state.getJSONArray(name); }
    private File part(String id) { return new File(partials, id + ".part"); }
    private File ready(String id) { return new File(files, id); }
    private static String iso() { return iso(System.currentTimeMillis()); }
    private static String iso(long millis) { SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US); f.setTimeZone(TimeZone.getTimeZone("UTC")); return f.format(new Date(millis)); }
    private String randomToken() { byte[] bytes = new byte[32]; random.nextBytes(bytes); return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    private static byte[] readAll(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) { if (output.size() + count > maximum) throw new IOException("内容超过大小限制。"); output.write(buffer, 0, count); }
        return output.toByteArray();
    }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(bytes.length * 2); for (byte b : bytes) out.append(String.format(Locale.US, "%02x", b & 255)); return out.toString(); }
    private static MessageDigest digest() { try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); } }
    private static String hash(byte[] bytes) { return hex(digest().digest(bytes)); }
    private static String hash(String text) { return hash(text.getBytes(StandardCharsets.UTF_8)); }
    private static String hash(File file) throws IOException {
        MessageDigest digest = digest(); byte[] buffer = new byte[128 * 1024]; int count;
        try (InputStream in = new FileInputStream(file)) { while ((count = in.read(buffer)) != -1) {if(BoundedHttpServer.cancelled())throw new IOException("Request cancelled");digest.update(buffer, 0, count);} }
        return hex(digest.digest());
    }
    private static boolean equal(String a, String b) { return a != null && b != null && MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8)); }
    private void persist() throws IOException {
        if(storageRecoveryRequired)throw new IOException("恢复提交结果需要重启确认，已暂停写入。");
        FileOutputStream out = null;
        String candidate = state.toString();
        byte[] bytes = candidate.getBytes(StandardCharsets.UTF_8);
        try {
            out = stateFile.startWrite(); out.write(bytes); out.getFD().sync(); stateFile.finishWrite(out); out = null;
            // Some platform AtomicFile versions log rename failures instead of throwing.
            try (InputStream in = stateFile.openRead()) {
                if (!Arrays.equals(bytes, readAll(in, Math.max(32 * 1024 * 1024, bytes.length)))) throw new IOException("中转站元数据未完整保存。");
            }
            committedState = candidate;
        } catch (IOException | RuntimeException error) {
            if (out != null) stateFile.failWrite(out);
            try { state = new JSONObject(committedState); } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
            throw error;
        }
    }
    private void recoverDeletes() throws IOException, JSONException {
        Set<String> pending = new HashSet<>(), published = new HashSet<>();
        JSONArray transfers = array("transfers"), ready = array("files");
        for (int i = 0; i < transfers.length(); i++) { JSONObject t = transfers.getJSONObject(i); if (!"complete".equals(t.optString("status"))) pending.add(t.getString("id")); }
        for (int i = 0; i < ready.length(); i++) published.add(ready.getJSONObject(i).getString("id"));
        published.addAll(pending);
        for (File directory : new File[]{partials, files}) {
            File[] tombstones = directory.listFiles((parent, name) -> name.endsWith(".deleted"));
            if (tombstones == null) continue;
            for (File tombstone : tombstones) {
                String name = tombstone.getName().substring(0, tombstone.getName().length() - 8);
                String id = directory.equals(partials) ? name.replaceFirst("\\.part$", "") : name;
                File original = new File(directory, name);
                if ((directory.equals(partials) ? pending : published).contains(id) && !original.exists()) {
                    if (!tombstone.renameTo(original)) throw new IOException("无法恢复中断的删除操作。");
                } else delete(tombstone);
            }
        }
    }
    private interface StateMutation { void run() throws JSONException; }
    private void discardFiles(File[] paths, StateMutation mutation) throws IOException, JSONException {
        List<File[]> moved = new ArrayList<>();
        try {
            for (File original : paths) if (original.exists()) {
                File tombstone = new File(original.getPath() + ".deleted");
                if (!original.renameTo(tombstone)) throw new IOException("文件被占用或无法删除。");
                moved.add(new File[]{original, tombstone});
            }
            mutation.run(); persist();
        } catch (Exception error) {
            Collections.reverse(moved);
            for (File[] item : moved) if (!item[1].renameTo(item[0])) error.addSuppressed(new IOException("文件需要重启中转站后恢复。"));
            throw error;
        }
        for (File[] item : moved) if (item[1].exists()) item[1].delete();
    }
    private JSONObject rotatePairing() throws JSONException, IOException {
        long expiry = System.currentTimeMillis() + 600_000;
        JSONObject pairing = object("code", String.format(Locale.US, "%06d", random.nextInt(1_000_000)), "expiresAt", iso(expiry), "expiresEpoch", expiry);
        state.put("pairing", pairing); persist();attempts.clear();globalAttempts.clear(); return publicPairing(pairing);
    }
    private JSONObject publicPairing(JSONObject p) throws JSONException { return object("code", p.getString("code"), "expiresAt", p.getString("expiresAt")); }
    private JSONObject publicDevice(JSONObject d) throws JSONException { return object("id", d.getString("id"), "name", d.getString("name"), "role", d.getString("role"), "revoked", d.optBoolean("revoked"), "lastSeen", d.optString("lastSeen")); }
    private JSONObject byId(String group, String id) throws JSONException { JSONArray list = array(group); for (int i = 0; i < list.length(); i++) { JSONObject item = list.getJSONObject(i); if (id.equals(item.optString("id"))) return item; } return null; }
    private void remove(String group, String id) throws JSONException { JSONArray old = array(group), replacement = new JSONArray(); for (int i = 0; i < old.length(); i++) if (!id.equals(old.getJSONObject(i).optString("id"))) replacement.put(old.get(i)); state.put(group, replacement); }
    private static boolean isHost(JSONObject device) { return "host".equals(device.optString("id")); }
    private void hostOnly(JSONObject device) throws ApiError { if (!isHost(device)) throw new ApiError(403, "HOST_ONLY", "只有中转站管理员可以执行此操作。"); }
    private JSONObject authenticate(IHTTPSession session) throws JSONException, IOException, ApiError {
        requestActive();
        String value = session.getHeaders().get("authorization");
        if (value == null || !value.startsWith("Bearer ")) throw new ApiError(401, "AUTH_REQUIRED", "请先配对设备。");
        value = value.substring(7); JSONObject found = null;
        if (equal(value, hostToken) && !Boolean.TRUE.equals(remoteRequest.get())) found = byId("devices", "host");
        else {
            String hashed = hash(value); JSONArray devices = array("devices");
            for (int i = 0; i < devices.length(); i++) { JSONObject d = devices.getJSONObject(i); if (!d.optBoolean("revoked") && "guest".equals(d.optString("role")) && equal(hashed, d.optString("tokenHash"))) { found = d; break; } }
        }
        if (found == null || found.optBoolean("revoked")) throw new ApiError(401, "AUTH_REVOKED", "设备连接已失效，请重新配对。");
        found.put("lastSeen", iso());
        if (System.currentTimeMillis() - lastSeenSave > 30_000) { persist(); lastSeenSave = System.currentTimeMillis(); }
        return found;
    }
    private static boolean visible(JSONObject item, JSONObject device) { String target = item.optString("targetId", ""); return isHost(device) || item.isNull("targetId") || target.isEmpty() || target.equals(device.optString("id")) || item.optString("senderId").equals(device.optString("id")); }
    private JSONObject file(String id, JSONObject device) throws JSONException, ApiError { return file(id,device,false); }
    private JSONObject file(String id, JSONObject device, boolean includeTrash) throws JSONException, ApiError { JSONObject f = byId("files", id); if (f == null || (!includeTrash&&f.has("deletedAt")) || !visible(f, device)) throw new ApiError(404, "FILE_NOT_FOUND", "文件不存在或你无权访问。"); return f; }
    private void requestActive()throws ApiError{if(BoundedHttpServer.cancelled())throw new ApiError(499,"REQUEST_CANCELLED","请求已取消。");if(sharingPaused&&!Boolean.TRUE.equals(localRequest.get()))throw new ApiError(503,"SHARING_PAUSED","已暂停对外共享。");}
    private void assertStillAuthorized(JSONObject device)throws JSONException,ApiError{requestActive();JSONObject current=byId("devices",device.optString("id"));if(current==null||current.optBoolean("revoked"))throw new ApiError(401,"AUTH_REVOKED","设备连接已失效，请重新配对。");}
    private JSONObject preferences(JSONObject device,boolean create)throws JSONException{
        JSONObject all=state.optJSONObject("preferences");if(all==null){all=new JSONObject();if(create)state.put("preferences",all);}JSONObject prefs=all.optJSONObject(device.optString("id"));
        if(prefs==null){prefs=object("collections",new JSONArray(),"files",new JSONObject());if(create)all.put(device.optString("id"),prefs);}return prefs;
    }
    private JSONObject fileView(JSONObject file,JSONObject device)throws JSONException{JSONObject prefs=preferences(device,false).optJSONObject("files"),value=prefs==null?null:prefs.optJSONObject(file.optString("id"));return FilePool.view(file).put("folderId",file.opt("folderId")==null?JSONObject.NULL:file.opt("folderId")).put("favorite",value!=null&&value.optBoolean("favorite")).put("collection",value==null||value.isNull("collection")?JSONObject.NULL:value.opt("collection"));}
    private static boolean contains(JSONArray values,String name){for(int i=0;i<values.length();i++)if(name.equals(values.optString(i)))return true;return false;}
    private static boolean validCollection(String name){return name!=null&&!name.trim().isEmpty()&&name.length()<=64&&!name.matches("(?s).*[\\x00-\\x1f\\x7f].*");}
    private void removeFilePreferences(String id)throws JSONException{JSONObject all=state.optJSONObject("preferences");if(all==null)return;Iterator<String> keys=all.keys();while(keys.hasNext()){JSONObject prefs=all.optJSONObject(keys.next()),values=prefs==null?null:prefs.optJSONObject("files");if(values!=null)values.remove(id);}}
    private JSONObject transfer(String id, JSONObject device) throws JSONException, ApiError { JSONObject t = byId("transfers", id); if (t == null || (!isHost(device) && !device.optString("id").equals(t.optString("senderId")))) throw new ApiError(404, "TRANSFER_NOT_FOUND", "传输任务不存在或你无权访问。"); return t; }
    private void ownerOnly(JSONObject item, JSONObject device) throws ApiError { if (!isHost(device) && !item.optString("senderId").equals(device.optString("id"))) throw new ApiError(403, "OWNER_ONLY", "只有发送者和管理员可以删除。"); }
    private String target(JSONObject input) throws JSONException, ApiError {
        if (!input.has("targetId") || input.isNull("targetId") || "".equals(input.optString("targetId"))) return null;
        Object target = input.get("targetId"); if (!(target instanceof String)) throw new ApiError(400, "INVALID_TARGET", "接收设备无效。");
        JSONObject d = byId("devices", (String) target); if (d == null || d.optBoolean("revoked")) throw new ApiError(400, "INVALID_TARGET", "接收设备不存在或已移除。"); return (String) target;
    }
    private JSONObject transferView(JSONObject t) throws JSONException {
        return object("id", t.getString("id"), "name", t.getString("name"), "size", t.getLong("size"), "offset", t.getLong("offset"), "status", t.getString("status"), "fingerprint", t.getString("fingerprint"), "senderId", t.getString("senderId"), "targetId", t.opt("targetId"), "folderId",t.opt("folderId"),"createdAt", t.getString("createdAt"), "chunkSize", CHUNK);
    }
    private String folder(JSONObject input,String target)throws Exception{try{String id=SharedFolders.nullable(input,"folderId");if(target!=null&&id!=null)throw new IOException("定向文件不能放入共享目录。");SharedFolders.find(state,id);return id;}catch(IOException error){throw new ApiError(400,"INVALID_FOLDER",error.getMessage());}}
    private Response duplicates(IHTTPSession session,byte[] bytes)throws Exception{
      JSONObject input=json(bytes,session);Object raw=input.opt("size"),checksum=input.opt("sha256");if(!(raw instanceof Number)||((Number)raw).doubleValue()!=((Number)raw).longValue()||((Number)raw).longValue()<0||((Number)raw).longValue()>MAX_FILE||!(checksum instanceof String)||!((String)checksum).matches("[a-fA-F0-9]{64}"))throw new ApiError(400,"INVALID_DUPLICATE_QUERY","文件校验信息无效。");long size=((Number)raw).longValue();String sha=((String)checksum).toLowerCase(Locale.US),destination,folder;List<JSONObject> candidates=new ArrayList<>();
      synchronized(mutex){JSONObject d=authenticate(session);destination=target(input);folder=folder(input,destination);JSONArray files=array("files");for(int i=0;i<files.length();i++){JSONObject f=files.getJSONObject(i);if(!f.has("deletedAt")&&visible(f,d)&&size==f.optLong("size")&&sha.equals(f.optString("sha256"))&&Objects.equals(destination,f.isNull("targetId")?null:f.optString("targetId"))&&Objects.equals(folder,f.isNull("folderId")?null:f.optString("folderId")))candidates.add(new JSONObject(f.toString()));}if(candidates.size()>50)candidates=candidates.subList(0,50);}
      JSONArray matches=new JSONArray();for(JSONObject candidate:candidates){String id=candidate.getString("id");File source=ready(id);if(!source.isFile()||source.length()!=size)continue;String before=PreviewIntegrity.stamp(source);if(!sha.equals(hash(source))||!before.equals(PreviewIntegrity.stamp(source)))continue;synchronized(mutex){JSONObject device=authenticate(session),latest=byId("files",id);if(latest!=null&&!latest.has("deletedAt")&&visible(latest,device)&&sha.equals(latest.optString("sha256"))&&Objects.equals(destination,latest.isNull("targetId")?null:latest.optString("targetId"))&&Objects.equals(folder,latest.isNull("folderId")?null:latest.optString("folderId")))matches.put(fileView(latest,device));}}
      synchronized(mutex){authenticate(session);}return response(200,object("matches",matches));
    }
    private List<String> ipv4() {
        ArrayList<String> result = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> nets = NetworkInterface.getNetworkInterfaces();
            while (nets != null && nets.hasMoreElements()) { NetworkInterface net = nets.nextElement(); Enumeration<InetAddress> addresses = net.getInetAddresses(); while (addresses.hasMoreElements()) { InetAddress a = addresses.nextElement(); if (a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) result.add(a.getHostAddress()); } }
        } catch (SocketException ignored) { }
        return result;
    }
    private void guard(IHTTPSession session) throws ApiError {
        if(sharingPaused&&!Boolean.TRUE.equals(localRequest.get()))throw new ApiError(503,"SHARING_PAUSED","文件池已暂停对其他设备共享，管理员仍可在本机管理。");
        String host = session.getHeaders().get("host");
        if (host == null || host.contains("@") || host.contains("/") || host.contains("\\")) throw new ApiError(403, "INVALID_HOST", "不允许此访问地址。");
        try {
            URI uri = new URI("http://" + host); String hostname = uri.getHost(); int port = uri.getPort() == -1 ? 80 : uri.getPort();
            boolean valid = "localhost".equals(hostname) || "127.0.0.1".equals(hostname) || "[::1]".equals(hostname) || "::1".equals(hostname) || ipv4().contains(hostname);
            boolean local=Boolean.TRUE.equals(localRequest.get());if(local&&!("localhost".equals(hostname)||"127.0.0.1".equals(hostname)))valid=false;
            boolean remote=Boolean.TRUE.equals(remoteRequest.get());
            if (remote ? !("127.0.0.1".equals(hostname)&&port>0&&port<=65535) : !valid || port != (local?getLocalPort():getPort())) throw new ApiError(403, "INVALID_HOST", "请使用中转站显示的局域网地址。");
            String origin = session.getHeaders().get("origin");
            if (origin != null && !origin.equals((identity!=null&&!local?"https://":"http://") + host)) throw new ApiError(403, "INVALID_ORIGIN", "拒绝来自其他网页的请求。");
            if (session.getUri().startsWith("/api/") && "cross-site".equals(session.getHeaders().get("sec-fetch-site"))) throw new ApiError(403, "CROSS_SITE_REQUEST", "拒绝来自其他网页的请求。");
        } catch (URISyntaxException e) { throw new ApiError(403, "INVALID_HOST", "访问地址无效。"); }
    }
    private byte[] body(IHTTPSession session, int maximum) throws IOException, ApiError {
        String raw = session.getHeaders().get("content-length");
        if (session.getHeaders().containsKey("transfer-encoding")) throw new ApiError(411, "LENGTH_REQUIRED", "请使用明确长度的数据块。");
        if (raw == null) return new byte[0];
        long length; try { length = Long.parseLong(raw); } catch (NumberFormatException e) { throw new ApiError(400, "INVALID_LENGTH", "请求长度无效。"); }
        if (length < 0 || length > maximum) throw new ApiError(413, "BODY_TOO_LARGE", "发送内容超过允许大小。");
        byte[] data = new byte[(int) length]; int at = 0;
        while (at < data.length) { int read = session.getInputStream().read(data, at, data.length - at); if (read == -1) throw new EOFException("传输中断。"); at += read; }
        return data;
    }
    private JSONObject json(byte[] bytes, IHTTPSession session) throws ApiError {
        String type = session.getHeaders().get("content-type");
        if (type != null && !type.toLowerCase(Locale.US).matches("application/json(?:;.*)?")) throw new ApiError(415, "JSON_REQUIRED", "请使用 JSON 请求。");
        if (bytes.length == 0) return new JSONObject();
        try { return new JSONObject(new String(bytes, StandardCharsets.UTF_8)); } catch (JSONException e) { throw new ApiError(400, "INVALID_JSON", "请求数据不是有效 JSON 对象。"); }
    }
    private static final class ApiError extends Exception {
        final int status; final String code; final JSONObject extra;
        ApiError(int status, String code, String message) { this(status, code, message, null); }
        ApiError(int status, String code, String message, JSONObject extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
    }
    private static final class Ticket { final String file, device,purpose; final long expires; Ticket(String file, String device, long expires,String purpose) { this.file = file; this.device = device; this.expires = expires;this.purpose=purpose; } }
    private static Response.IStatus status(final int code) { return new Response.IStatus() { public int getRequestStatus() { return code; } public String getDescription() { switch (code) { case 200:return "200 OK"; case 201:return "201 Created"; case 204:return "204 No Content"; case 206:return "206 Partial Content"; case 400:return "400 Bad Request"; case 401:return "401 Unauthorized"; case 403:return "403 Forbidden"; case 404:return "404 Not Found"; case 409:return "409 Conflict"; case 411:return "411 Length Required"; case 413:return "413 Payload Too Large"; case 415:return "415 Unsupported Media Type"; case 416:return "416 Range Not Satisfiable"; case 422:return "422 Unprocessable Entity"; case 429:return "429 Too Many Requests"; case 501:return "501 Not Implemented"; case 503:return "503 Service Unavailable"; case 507:return "507 Insufficient Storage"; default:return code + " Error"; } } }; }
    private static Response response(int code, JSONObject value) { Response r = newFixedLengthResponse(status(code), "application/json; charset=utf-8", value.toString()); headers(r); r.addHeader("Cache-Control", "no-store"); return r; }
    private static void headers(Response r) { r.addHeader("X-Content-Type-Options", "nosniff"); r.addHeader("Referrer-Policy", "no-referrer"); r.addHeader("X-Frame-Options", "DENY"); r.addHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()"); }
    private static boolean validName(String s) { if (s == null || s.trim().isEmpty() || s.length() > 255 || s.equals(".") || s.equals("..") || s.matches("(?s).*[\\x00-\\x1f\\x7f/\\\\].*")) return false; for (int i=0; i<s.length();i++) { char c=s.charAt(i); if (Character.isHighSurrogate(c)) { if (++i>=s.length() || !Character.isLowSurrogate(s.charAt(i))) return false; } else if (Character.isLowSurrogate(c)) return false; } return true; }

    @Override public Response serve(IHTTPSession session) {
        String activeDevice=null;Closeable activeSocket=BoundedHttpServer.currentSocket();
        try {
            guard(session);
            BoundedHttpServer.beginBody();
            String uri = session.getUri(); Method method = session.getMethod();
            if (method == Method.OPTIONS) { Response r = newFixedLengthResponse(status(204), "text/plain", ""); headers(r); return r; }
            boolean publicRoute = uri.equals("/api/pair") || uri.equals("/api/health") || uri.equals("/api/identity") || uri.matches("/api/files/[a-zA-Z0-9-]+/(content|media)");
            if (uri.startsWith("/api/") && !publicRoute) synchronized (mutex) { activeDevice=authenticate(session).getString("id");if(activeSocket!=null)requests.computeIfAbsent(activeDevice,k->new HashSet<>()).add(activeSocket); }
            byte[] bytes = new byte[0];
            if (method == Method.POST || method == Method.PUT || method == Method.DELETE || method == Method.PATCH) bytes = body(session, method == Method.PUT ? CHUNK : method==Method.PATCH?2048:96 * 1024);
            synchronized(mutex){if(storageRecoveryRequired)throw new ApiError(503,"STORAGE_RECOVERY_REQUIRED","恢复提交结果需要重启确认，请勿重复导入。");if(storageBusy&&method!=Method.GET&&method!=Method.HEAD&&!maintenanceSecurity(uri,method))throw new ApiError(503,"STORAGE_BUSY","文件池正在备份或恢复，请稍后重试。");}
            if(uri.equals("/api/files/duplicates")&&method==Method.POST)return duplicates(session,bytes);
            Matcher media=Pattern.compile("^/api/files/([a-zA-Z0-9-]+)/media$").matcher(uri);
            if(media.matches()&&(method==Method.GET||method==Method.HEAD))return media(session,media.group(1));
            Matcher completion = Pattern.compile("^/api/transfers/([a-zA-Z0-9-]+)/complete$").matcher(uri);
            if (method == Method.POST && completion.matches()) return finalizeTransfer(session, bytes, completion.group(1));
            Matcher preview=Pattern.compile("^/api/files/([a-zA-Z0-9-]+)/preview$").matcher(uri);
            if (preview.matches() && (method==Method.GET||method==Method.HEAD)) return preview(session,preview.group(1));
            Matcher text=Pattern.compile("^/api/files/([a-zA-Z0-9-]+)/text$").matcher(uri);
            if (text.matches() && (method==Method.GET||method==Method.HEAD)) return textPreview(session,text.group(1));
            // Request bodies are read outside the state lock; a slow client cannot block revocation.
            synchronized (mutex) { return dispatch(session, bytes); }
        } catch (ApiError error) {
            try {
                JSONObject payload = object("error", error.getMessage(), "code", error.code);
                if (error.extra != null) { Iterator<String> keys = error.extra.keys(); while (keys.hasNext()) { String key = keys.next(); payload.put(key, error.extra.get(key)); } }
                Response r = response(error.status, payload); r.addHeader("Connection", "close"); if (error.status == 429) r.addHeader("Retry-After", "600"); return r;
            } catch (JSONException impossible) { return newFixedLengthResponse(status(500), "text/plain", "Internal error"); }
        } catch (IOException error) {
            try { String message = error.getMessage() == null ? "" : error.getMessage(); boolean full = message.contains("ENOSPC") || message.contains("No space"); Response r = response(full ? 507 : 503, object("error", full ? "存储空间不足，释放空间后可继续上传。" : "文件读写未完成，请检查存储空间后重试。", "code", full ? "DISK_FULL" : "STORAGE_UNAVAILABLE")); r.addHeader("Connection", "close"); return r; } catch (JSONException impossible) { return newFixedLengthResponse(status(500), "text/plain", "Internal error"); }
        } catch (Exception error) {
            try { Response r = response(500, object("error", "操作未完成，请重试。", "code", "INTERNAL_ERROR")); r.addHeader("Connection", "close"); return r; } catch (JSONException impossible) { return newFixedLengthResponse(status(500), "text/plain", "Internal error"); }
        }finally{BoundedHttpServer.responseReady();if(activeDevice!=null&&activeSocket!=null)synchronized(mutex){Set<Closeable> values=requests.get(activeDevice);if(values!=null){values.remove(activeSocket);if(values.isEmpty())requests.remove(activeDevice);}}}
    }

    private static boolean maintenanceSecurity(String uri,Method method){return method==Method.POST&&(uri.equals("/api/pairing/rotate")||uri.equals("/api/pairing/reset-limits")||uri.matches("/api/devices/[a-zA-Z0-9-]+/revoke"));}
    private Response dispatch(IHTTPSession s, byte[] bytes) throws Exception {
        requestActive();
        String uri = s.getUri(); Method method = s.getMethod();
        if(storageRecoveryRequired)throw new ApiError(503,"STORAGE_RECOVERY_REQUIRED","恢复提交结果需要重启确认，请勿重复导入。");if(storageBusy&&method!=Method.GET&&method!=Method.HEAD&&!maintenanceSecurity(uri,method))throw new ApiError(503,"STORAGE_BUSY","文件池正在备份或恢复，请稍后重试。");
        if (uri.equals("/api/health") && method == Method.GET) return response(200, object("ok", true, "name", "星月夜", "version", "1.9.3"));
        if(uri.equals("/api/identity")&&method==Method.GET){if(identity==null)throw new ApiError(503,"TLS_UNAVAILABLE","安全身份尚未就绪。");return response(200,identity.json());}
        if (uri.equals("/api/pair") && method == Method.POST) {
            JSONObject input = json(bytes, s); String remote = pairingPeer(s); long cutoff = System.currentTimeMillis() - 600_000;
            attempts.entrySet().removeIf(e->{e.getValue().removeIf(time->time<cutoff);return e.getValue().isEmpty();});
            globalAttempts.removeIf(time->time<cutoff);if(globalAttempts.size()>=100||attempts.size()>=1000&&!attempts.containsKey(remote))throw new ApiError(429,"PAIR_RATE_LIMIT","配对尝试过多，请 10 分钟后重试。");
            List<Long> failures = attempts.get(remote); if (failures == null) { failures = new ArrayList<>(); attempts.put(remote, failures); }
            Iterator<Long> iterator = failures.iterator(); while (iterator.hasNext()) if (iterator.next() < cutoff) iterator.remove();
            iterator = globalAttempts.iterator(); while (iterator.hasNext()) if (iterator.next() < cutoff) iterator.remove();
            if (failures.size() >= 10 || globalAttempts.size() >= 100) throw new ApiError(429, "PAIR_RATE_LIMIT", "配对尝试过多，请 10 分钟后重试。");
            JSONObject pairing = state.getJSONObject("pairing");
            if (!(input.opt("code") instanceof String) || !equal(input.optString("code"), pairing.getString("code")) || pairing.getLong("expiresEpoch") <= System.currentTimeMillis()) { failures.add(System.currentTimeMillis()); globalAttempts.add(System.currentTimeMillis()); throw new ApiError(403, "INVALID_PAIR_CODE", "配对码错误或已过期，请在中转站刷新配对码。"); }
            String name = input.opt("name") instanceof String ? input.getString("name").trim() : "";
            if (name.isEmpty() || name.length() > 60 || name.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new ApiError(400, "INVALID_DEVICE_NAME", "设备名称需为 1–60 个字符。");
            int active = 0; JSONArray devices = array("devices"); for (int i=0;i<devices.length();i++) if (!devices.getJSONObject(i).optBoolean("revoked")) active++;
            if (active >= 64) throw new ApiError(409, "DEVICE_LIMIT", "已达到设备数量上限，请先移除不使用的设备。");
            String credential = randomToken(); JSONObject d = object("id", UUID.randomUUID().toString(), "name", name, "role", "guest", "tokenHash", hash(credential), "revoked", false, "createdAt", iso(), "lastSeen", iso());
            devices.put(d); persist(); attempts.remove(remote); return response(201, object("token", credential, "device", publicDevice(d)));
        }
        Matcher match = Pattern.compile("^/api/files/([a-zA-Z0-9-]+)/content$").matcher(uri);
        if (match.matches() && (method == Method.GET || method == Method.HEAD)) return download(s, match.group(1));
        if (!uri.startsWith("/api/")) return asset(s);
        JSONObject device = authenticate(s); String deviceId = device.getString("id");
        if (uri.equals("/api/state") && method == Method.GET) {
            JSONArray devices = new JSONArray(), shownFiles = new JSONArray(), trashedFiles=new JSONArray(), transfers = new JSONArray(), notes = new JSONArray(), urls = new JSONArray();long activeBytes=0,trashBytes=0;
            JSONArray all = array("devices"); for (int i=0;i<all.length();i++) if (isHost(device) || !all.getJSONObject(i).optBoolean("revoked")) devices.put(publicDevice(all.getJSONObject(i)));
            all = array("files"); for (int i=all.length()-1;i>=0;i--){JSONObject f=all.getJSONObject(i);if(f.has("deletedAt")){if(isHost(device)||deviceId.equals(f.optString("senderId"))){trashedFiles.put(fileView(f,device));trashBytes+=f.optLong("size");}}else if(visible(f,device)){shownFiles.put(fileView(f,device));activeBytes+=f.optLong("size");}}
            all = array("transfers"); for (int i=all.length()-1;i>=0;i--) { JSONObject t=all.getJSONObject(i); if (!"complete".equals(t.optString("status")) && (isHost(device) || deviceId.equals(t.optString("senderId")))) transfers.put(transferView(t)); }
            all = array("notes"); for (int i=all.length()-1;i>=0;i--) if (visible(all.getJSONObject(i),device)) notes.put(all.get(i));
            if(identity!=null)for (String ip : ipv4()) urls.put("https://"+ip+":"+getPort());
            JSONObject storage=object("activeBytes",activeBytes,"trashBytes",trashBytes,"scope",isHost(device)?"host":"visible");if(isHost(device))storage.put("availableBytes",directory.getUsableSpace());
            JSONObject security=object("sharingPaused",sharingPaused,"tlsEnabled",identity!=null,"serverId",identity==null?null:identity.serverId,"certificateFingerprint",identity==null?null:identity.fingerprint,"certificateExpiresAt",identity==null?null:identity.expiresAt,"transport",Boolean.TRUE.equals(localRequest.get())?"loopback":identity!=null?"tls":"http");
            if(isHost(device))storage.put("dataDirectory",directory.getAbsolutePath()).put("backupAvailable",Boolean.TRUE.equals(localRequest.get()));
            return response(200, object("device",publicDevice(device),"devices",devices,"files",shownFiles,"trash",trashedFiles,"folders",SharedFolders.all(state),"collections",preferences(device,false).getJSONArray("collections"),"storage",storage,"sharing",object("paused",sharingPaused),"capabilities",object("fileOrganization",true,"trash",true,"textPreview",true,"richPreview",true,"sharedFolders",true,"duplicateDetection",true,"pagedPreview",true,"mediaPreview",true,"nativeBackup",true),"security",security,"transfers",transfers,"notes",notes,"network",object("urls",urls,"hostname",Build.MODEL,"port",getPort(),"platform","android"),"pairing",isHost(device)?publicPairing(state.getJSONObject("pairing")):null,"limits",object("chunkSize",CHUNK,"maxFileSize",MAX_FILE),"bluetooth",object("available",false)));
        }
        if(uri.equals("/api/folders/ensure")&&method==Method.POST){JSONObject input=json(bytes,s);assertStillAuthorized(device);JSONObject before=new JSONObject(state.toString());try{JSONObject result=SharedFolders.ensure(state,SharedFolders.nullable(input,"parentId"),input.optJSONArray("path"),deviceId,iso());persist();return response(200,result);}catch(IOException error){state=before;throw new ApiError(400,"INVALID_FOLDER",error.getMessage());}}
        match=Pattern.compile("^/api/folders/([a-fA-F0-9-]+)$").matcher(uri);
        if(match.matches()&&(method==Method.PATCH||method==Method.DELETE)){assertStillAuthorized(device);JSONObject folder;try{folder=SharedFolders.find(state,match.group(1));}catch(IOException missing){throw new ApiError(404,"FOLDER_NOT_FOUND","共享目录不存在。");}String id=folder.getString("id");if(!isHost(device)&&!deviceId.equals(folder.optString("createdBy")))throw new ApiError(403,"OWNER_ONLY","只有目录创建者和管理员可以修改目录。");
          if(method==Method.DELETE){for(String group:new String[]{"folders","files","transfers"}){JSONArray values=array(group);for(int i=0;i<values.length();i++){JSONObject value=values.getJSONObject(i);if(id.equals(value.optString("folders".equals(group)?"parentId":"folderId"))&&(!"transfers".equals(group)||!"complete".equals(value.optString("status"))))throw new ApiError(409,"FOLDER_NOT_EMPTY","请先移出目录内文件、回收站项目和未完成任务。");}}remove("folders",id);persist();return response(200,object("ok",true));}
          JSONObject input=json(bytes,s);if(input.length()==0||input.length()>2)throw new ApiError(400,"INVALID_FOLDER","目录修改内容无效。");Iterator<String> keys=input.keys();while(keys.hasNext())if(!Arrays.asList("name","parentId").contains(keys.next()))throw new ApiError(400,"INVALID_FOLDER","目录修改字段无效。");JSONObject before=new JSONObject(state.toString());try{if(input.has("name")){if(!(input.opt("name") instanceof String))throw new IOException("目录名称无效。");folder.put("name",SafTreeFiles.segment(input.getString("name")));}if(input.has("parentId")){String parent=SharedFolders.nullable(input,"parentId");SharedFolders.find(state,parent);folder.put("parentId",parent==null?JSONObject.NULL:parent);}SharedFolders.validateTree(state);persist();return response(200,folder);}catch(IOException error){state=before;throw new ApiError(400,"INVALID_FOLDER",error.getMessage());}
        }
        match=Pattern.compile("^/api/files/([a-fA-F0-9-]+)/location$").matcher(uri);
        if(match.matches()&&method==Method.PATCH){JSONObject input=json(bytes,s);assertStillAuthorized(device);JSONObject f=file(match.group(1),device);ownerOnly(f,device);if(input.length()==0||input.length()>2)throw new ApiError(400,"INVALID_LOCATION","文件位置无效。");Iterator<String> keys=input.keys();while(keys.hasNext())if(!Arrays.asList("folderId","name").contains(keys.next()))throw new ApiError(400,"INVALID_LOCATION","文件位置字段无效。");String folder=folder(input,f.isNull("targetId")?null:f.optString("targetId"));if(input.has("name")&&(!(input.opt("name") instanceof String)||!validName(input.getString("name"))))throw new ApiError(400,"INVALID_FILENAME","文件名无效。");f.put("folderId",folder==null?JSONObject.NULL:folder);if(input.has("name"))f.put("name",input.getString("name"));persist();return response(200,fileView(f,device));}
        if(uri.equals("/api/collections")&&method==Method.POST){
            JSONObject input=json(bytes,s);assertStillAuthorized(device);String name=input.opt("name") instanceof String?input.getString("name").trim():"";if(!validCollection(name))throw new ApiError(400,"INVALID_COLLECTION","文件夹名称需为 1–64 个字符。");
            JSONObject prefs=preferences(device,true);JSONArray collections=prefs.getJSONArray("collections");if(!contains(collections,name)){if(collections.length()>=100)throw new ApiError(409,"COLLECTION_LIMIT","最多可建立 100 个文件夹。");collections.put(name);persist();}return response(200,object("name",name));
        }
        if(uri.startsWith("/api/collections/")&&method==Method.DELETE){
            assertStillAuthorized(device);String name=uri.substring("/api/collections/".length());JSONObject prefs=preferences(device,true);JSONArray previous=prefs.getJSONArray("collections"),kept=new JSONArray();for(int i=0;i<previous.length();i++)if(!name.equals(previous.optString(i)))kept.put(previous.get(i));prefs.put("collections",kept);
            JSONObject values=prefs.getJSONObject("files");Iterator<String> keys=values.keys();while(keys.hasNext()){JSONObject value=values.optJSONObject(keys.next());if(value!=null&&name.equals(value.optString("collection")))value.put("collection",JSONObject.NULL);}persist();return response(200,object("ok",true));
        }
        if (uri.equals("/api/pairing/rotate") && method == Method.POST) { hostOnly(device); json(bytes,s); return response(200,rotatePairing()); }
        if(uri.equals("/api/pairing/reset-limits")&&method==Method.POST){hostOnly(device);json(bytes,s);return response(200,object("ok",true,"pairing",rotatePairing()));}
        match = Pattern.compile("^/api/devices/([a-zA-Z0-9-]+)/revoke$").matcher(uri);
        if (match.matches() && method == Method.POST) {
            hostOnly(device); json(bytes,s); JSONObject d=byId("devices",match.group(1)); if (d==null || "host".equals(d.optString("id"))) throw new ApiError(404,"DEVICE_NOT_FOUND","设备不存在。");
            d.put("revoked",true);d.put("revokedAt",iso());persist();revokeActive(d.getString("id")); return response(200,object("ok",true));
        }
        if (uri.equals("/api/transfers") && method == Method.POST) {
            JSONObject input=json(bytes,s); String name=input.opt("name") instanceof String?input.getString("name"):null;
            if (!validName(name)) throw new ApiError(400,"INVALID_FILENAME","文件名无效，不能包含路径或控制字符。");
            Object numeric=input.opt("size"); if (!(numeric instanceof Number)) throw new ApiError(400,"INVALID_FILE_SIZE","文件大小无效。");
            long size=((Number)numeric).longValue(); if (size<0||size>MAX_FILE||((Number)numeric).doubleValue()!=size) throw new ApiError(400,"INVALID_FILE_SIZE","文件大小超出允许范围。");
            Object rawFingerprint=input.opt("fingerprint");if(!(rawFingerprint instanceof String)||!((String)rawFingerprint).matches("[a-fA-F0-9]{64}")) throw new ApiError(400,"INVALID_FINGERPRINT","文件识别信息无效，必须提供完整文件的 SHA-256。");
            String fingerprint=((String)rawFingerprint).toLowerCase(Locale.US);
            String target=target(input),folder=folder(input,target);JSONArray list=array("transfers");int pending=0;
            for(int i=0;i<list.length();i++){JSONObject t=list.getJSONObject(i);if(!"complete".equals(t.optString("status"))){pending++;String oldTarget=t.isNull("targetId")?null:t.optString("targetId");if(deviceId.equals(t.optString("senderId"))&&fingerprint.equals(t.optString("fingerprint"))&&name.equals(t.optString("name"))&&size==t.optLong("size")&&Objects.equals(target,oldTarget)&&Objects.equals(folder,t.isNull("folderId")?null:t.optString("folderId")))return response(200,transferView(t));}}
            if(pending>=1000)throw new ApiError(409,"TRANSFER_LIMIT","待完成任务过多，请取消不需要的任务。");
            String id=UUID.randomUUID().toString(); if(!part(id).createNewFile())throw new IOException("无法创建文件。");
            JSONObject t=object("id",id,"name",name,"size",size,"lastModified",input.optLong("lastModified"),"fingerprint",fingerprint,"senderId",deviceId,"senderName",device.getString("name"),"targetId",target,"folderId",folder,"offset",0,"status","uploading","createdAt",iso());
            list.put(t);try{persist();}catch(IOException|RuntimeException error){part(id).delete();throw error;}return response(201,transferView(t));
        }
        match=Pattern.compile("^/api/transfers/([a-zA-Z0-9-]+)(/complete)?$").matcher(uri);
        if(match.matches()){
            String id=match.group(1);boolean complete=match.group(2)!=null;JSONObject t=transfer(id,device);
            if(method==Method.GET&&!complete)return response(200,transferView(t));
            if(method==Method.PUT&&!complete){
                String offsetRaw=s.getHeaders().get("x-offset"), checksum=s.getHeaders().get("x-chunk-sha256");
                if(offsetRaw==null||!offsetRaw.matches("[0-9]+"))throw new ApiError(400,"INVALID_OFFSET","分块偏移无效。");
                long offset;try{offset=Long.parseLong(offsetRaw);}catch(NumberFormatException e){throw new ApiError(400,"INVALID_OFFSET","分块偏移无效。");}
                if(checksum==null||!checksum.matches("(?i)[a-f0-9]{64}"))throw new ApiError(400,"CHECKSUM_REQUIRED","每个分块都需要 SHA-256 校验值。");
                if(bytes.length==0)throw new ApiError(400,"EMPTY_CHUNK","不能上传空数据块。");
                if(!equal(hash(bytes),checksum.toLowerCase(Locale.US)))throw new ApiError(422,"CHECKSUM_MISMATCH","分块校验失败，请重试。");
                long confirmed=t.getLong("offset");
                if("complete".equals(t.optString("status")))throw new ApiError(409,"ALREADY_COMPLETE","文件已上传完成。",object("offset",confirmed));
                if(offset!=confirmed)throw new ApiError(409,"OFFSET_MISMATCH","传输位置已更新，请同步后继续。",object("offset",confirmed));
                if(confirmed+bytes.length>t.getLong("size"))throw new ApiError(400,"SIZE_EXCEEDED","数据超过文件声明大小。");
                try(RandomAccessFile out=new RandomAccessFile(part(id),"rw")){try{out.seek(confirmed);out.write(bytes);out.getFD().sync();}catch(IOException e){out.setLength(confirmed);throw e;}}
                t.put("offset",confirmed+bytes.length);persist();return response(200,object("id",id,"offset",t.getLong("offset")));
            }
            if(method==Method.DELETE&&!complete){if(finalizing.contains(id))throw new ApiError(409,"VERIFYING","文件正在校验，请稍后再取消。");if("complete".equals(t.optString("status")))throw new ApiError(409,"ALREADY_COMPLETE","文件已完成，请从文件列表删除。");discardFiles(new File[]{part(id),ready(id)},()->remove("transfers",id));return response(200,object("ok",true));}
        }
        match=Pattern.compile("^/api/files/([a-zA-Z0-9-]+)/(restore|permanent)$").matcher(uri);
        if(match.matches()&&((method==Method.POST&&"restore".equals(match.group(2)))||(method==Method.DELETE&&"permanent".equals(match.group(2))))){
            if(method==Method.POST)json(bytes,s);assertStillAuthorized(device);String id=match.group(1);JSONObject f=file(id,device,true);ownerOnly(f,device);if(!f.has("deletedAt"))throw new ApiError(409,"NOT_IN_TRASH","文件不在回收站中。");
            if("restore".equals(match.group(2))){f.remove("deletedAt");f.remove("deletedBy");persist();return response(200,fileView(f,device));}
            discardFiles(new File[]{ready(id)},()->{remove("files",id);remove("transfers",id);removeFilePreferences(id);});previews.invalidate(id);previewIntegrity.invalidate(id);Iterator<Ticket> oldTickets=tickets.values().iterator();while(oldTickets.hasNext())if(id.equals(oldTickets.next().file))oldTickets.remove();return response(200,object("ok",true));
        }
        match=Pattern.compile("^/api/files/([a-zA-Z0-9-]+)(/ticket)?$").matcher(uri);
        if(match.matches()){
            String id=match.group(1);JSONObject f=file(id,device);
            if(method==Method.POST&&match.group(2)!=null){JSONObject input=json(bytes,s);assertStillAuthorized(device);String purpose=input.optString("purpose","download");if(!purpose.equals("download")&&!purpose.equals("media"))throw new ApiError(400,"INVALID_TICKET_PURPOSE","下载用途无效。");if(purpose.equals("media")&&FilePool.mediaMime(f)==null)throw new ApiError(415,"MEDIA_UNAVAILABLE","此媒体格式不支持在线播放。");Iterator<Ticket> it=tickets.values().iterator();while(it.hasNext())if(it.next().expires<=System.currentTimeMillis())it.remove();if(tickets.size()>=10000)throw new ApiError(429,"TICKET_LIMIT","下载请求过多，请稍后再试。");String secret=randomToken();long expires=System.currentTimeMillis()+(purpose.equals("media")?300_000:600_000);tickets.put(hash(secret),new Ticket(id,deviceId,expires,purpose));return response(200,object("url","/api/files/"+id+(purpose.equals("media")?"/media":"/content")+"?ticket="+secret,"expiresAt",iso(expires),"ticket",secret));}
            if(method==Method.DELETE&&match.group(2)!=null){JSONObject input=json(bytes,s);String secret=input.optString("ticket");Ticket ticket=tickets.get(hash(secret));if(ticket!=null&&id.equals(ticket.file)&&deviceId.equals(ticket.device))tickets.remove(hash(secret));return response(200,object("ok",true));}
            if(method==Method.DELETE&&match.group(2)==null){assertStillAuthorized(device);ownerOnly(f,device);f.put("deletedAt",iso());f.put("deletedBy",deviceId);persist();previews.invalidate(id);previewIntegrity.invalidate(id);Iterator<Ticket> it=tickets.values().iterator();while(it.hasNext())if(id.equals(it.next().file))it.remove();return response(200,object("ok",true));}
            if(method==Method.PATCH&&match.group(2)==null){JSONObject input=json(bytes,s);assertStillAuthorized(device);boolean valid=input.length()>0;Iterator<String> keys=input.keys();while(keys.hasNext()){String key=keys.next();if(!"favorite".equals(key)&&!"collection".equals(key))valid=false;}if(input.has("favorite")&&!(input.opt("favorite") instanceof Boolean))valid=false;if(input.has("collection")&&!input.isNull("collection")&&!(input.opt("collection") instanceof String))valid=false;if(!valid)throw new ApiError(400,"INVALID_FILE_PREFERENCE","文件整理设置无效。");
                JSONObject prefs=preferences(device,true);if(input.has("collection")&&!input.isNull("collection")&&!contains(prefs.getJSONArray("collections"),input.getString("collection")))throw new ApiError(400,"COLLECTION_NOT_FOUND","请先建立文件夹。");
                JSONObject values=prefs.getJSONObject("files"),value=values.optJSONObject(id);if(value==null){value=new JSONObject();values.put(id,value);}keys=input.keys();while(keys.hasNext()){String key=keys.next();value.put(key,input.get(key));}persist();return response(200,fileView(f,device));
            }
        }
        if(uri.equals("/api/notes")&&method==Method.POST){
            JSONObject input=json(bytes,s);assertStillAuthorized(device);Object text=input.opt("text");if(!(text instanceof String)||((String)text).trim().isEmpty()||((String)text).length()>20000||((String)text).indexOf('\u0000')>=0)throw new ApiError(400,"INVALID_NOTE","文字内容需为 1–20000 个字符。");String destination=target(input),clientId=null;
            if(input.has("clientId")){if(!(input.opt("clientId") instanceof String)||!input.getString("clientId").matches("(?i)[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}"))throw new ApiError(400,"INVALID_CLIENT_ID","任务编号无效。");clientId=input.getString("clientId");}
            JSONArray notes=array("notes");if(clientId!=null)for(int i=0;i<notes.length();i++){JSONObject previous=notes.getJSONObject(i);if(deviceId.equals(previous.optString("senderId"))&&clientId.equals(previous.optString("clientId"))){String oldTarget=previous.isNull("targetId")?null:previous.optString("targetId");if(!text.equals(previous.optString("text"))||!Objects.equals(destination,oldTarget))throw new ApiError(409,"CLIENT_ID_CONFLICT","任务编号已用于不同的文字或接收设备。");return response(200,previous);}}
            if(notes.length()>=5000)throw new ApiError(409,"NOTE_LIMIT","文字收件箱已满，请删除不需要的内容。");JSONObject n=object("id",UUID.randomUUID().toString(),"text",text,"createdAt",iso(),"senderId",deviceId,"senderName",device.getString("name"),"targetId",destination);if(clientId!=null)n.put("clientId",clientId);notes.put(n);persist();return response(201,n);
        }
        match=Pattern.compile("^/api/notes/([a-zA-Z0-9-]+)$").matcher(uri);
        if(match.matches()&&method==Method.DELETE){JSONObject note=byId("notes",match.group(1));if(note==null||!visible(note,device))throw new ApiError(404,"NOTE_NOT_FOUND","文字内容不存在或你无权访问。");ownerOnly(note,device);remove("notes",match.group(1));persist();return response(200,object("ok",true));}
        if(uri.startsWith("/api/bluetooth/"))throw new ApiError(501,"BLUETOOTH_UNAVAILABLE","请使用应用顶部的系统蓝牙入口。");
        throw new ApiError(404,"NOT_FOUND","接口不存在。");
    }

    private Response finalizeTransfer(IHTTPSession session, byte[] bytes, String id) throws Exception {
        File source;
        synchronized (mutex) {
            if(storageBusy)throw new ApiError(503,"STORAGE_BUSY","文件池正在备份或恢复，请稍后重试。");
            json(bytes, session);
            JSONObject device = authenticate(session), transfer = transfer(id, device);
            boolean published = "complete".equals(transfer.optString("status"));
            if (published) file(id, device);
            if (transfer.getLong("offset") != transfer.getLong("size")) throw new ApiError(409, "INCOMPLETE_UPLOAD", "文件尚未上传完整。", object("offset", transfer.getLong("offset")));
            if (finalizing.contains(id)) throw new ApiError(409, "VERIFYING", "文件正在校验，请稍后重试。");
            source = !published && part(id).exists() ? part(id) : ready(id);
            if (!source.exists()) throw new ApiError(404, "FILE_MISSING", "文件已不在中转站中。");
            if (source.length() != transfer.getLong("size")) throw new ApiError(409, "SIZE_MISMATCH", "磁盘文件大小不一致，请重新上传。", object("offset", source.length()));
            finalizing.add(id);
        }
        try {
            // Hashing a large file must not freeze discovery, pairing, revocation or other uploads.
            String checksum = hash(source);
            synchronized (mutex) {
                JSONObject device = authenticate(session), transfer = transfer(id, device);
                String expected = transfer.optString("fingerprint").toLowerCase(Locale.US);
                boolean published = "complete".equals(transfer.optString("status"));
                if (!expected.matches("[a-f0-9]{64}") || !equal(checksum, expected)) throw new ApiError(422, "FILE_HASH_MISMATCH", published ? "已保存文件与原文件校验不一致，请删除中转站副本后重新上传。" : "完整文件校验失败，文件未发布。请取消此任务后重新上传原文件。", object("expectedSha256", expected, "actualSha256", checksum, "offset", transfer.getLong("offset")));
                if (published) {
                    JSONObject existing = file(id, device);
                    if (!equal(existing.optString("sha256").toLowerCase(Locale.US), checksum)) throw new ApiError(422, "FILE_HASH_MISMATCH", "已完成文件的校验记录不一致，请删除中转站副本后重新上传。", object("expectedSha256", expected, "actualSha256", checksum));
                    return response(200, fileView(existing,device));
                }
                if (!source.equals(ready(id)) && !source.renameTo(ready(id))) throw new IOException("无法完成文件保存。");
                JSONObject file = object("id", id, "name", transfer.getString("name"), "size", transfer.getLong("size"), "sha256", checksum, "createdAt", iso(), "lastModified",transfer.optLong("lastModified"),"senderId", transfer.getString("senderId"), "senderName", transfer.getString("senderName"), "targetId", transfer.opt("targetId"),"folderId",transfer.opt("folderId"));
                transfer.put("status", "complete"); array("files").put(file); persist(); return response(200, fileView(file,device));
            }
        } finally { synchronized (mutex) { finalizing.remove(id); } }
    }

    private static void delete(File file) throws IOException { if(file.exists()&&!file.delete())throw new IOException("文件被占用或无法删除。"); }
    private Response preview(IHTTPSession session,String id)throws Exception{
        File source;String checksum,kind;long size,modified;String mode=session.getParms().get("mode"),pageRaw=session.getParms().get("page");if(mode==null)mode="thumbnail";if(!mode.equals("thumbnail")&&!mode.equals("detail"))throw new ApiError(400,"INVALID_PREVIEW_MODE","预览模式无效。");int page=1;try{if(pageRaw!=null){if(!pageRaw.matches("[1-9][0-9]{0,3}"))throw new NumberFormatException();page=Integer.parseInt(pageRaw);}if(page>1000)throw new NumberFormatException();}catch(NumberFormatException error){throw new ApiError(400,"INVALID_PREVIEW_PAGE","预览页码需为 1–1,000。");}
        synchronized(mutex){JSONObject info=file(id,authenticate(session));if(!FilePool.previewable(info))throw new ApiError(415,"PREVIEW_UNAVAILABLE","此文件不支持小图预览，原件仍可保存。");kind=FilePool.previewKind(info);source=ready(id);if(!source.isFile())throw new ApiError(404,"FILE_MISSING","文件已不在中转站中。");size=source.length();modified=source.lastModified();checksum=info.getString("sha256");if(size!=info.getLong("size"))throw new ApiError(415,"PREVIEW_UNAVAILABLE","文件状态已变化，请重新上传原件。");}
        if(!"pdf".equals(kind)&&page!=1)throw new ApiError(400,"INVALID_PREVIEW_PAGE","此文件只有一张预览。");
        if(pendingPreviews.incrementAndGet()>4){pendingPreviews.decrementAndGet();throw new ApiError(429,"PREVIEW_BUSY","预览请求较多，请稍后重试。");}
        ImagePreviews.Result generated;try{generated=previews.generate(source,id+":"+checksum+":"+PreviewIntegrity.stamp(source)+":"+mode+":"+page,checksum,kind,mode,page);}catch(IOException|LinkageError error){throw new ApiError(415,"PREVIEW_UNAVAILABLE","暂不能生成预览，原文件仍可保存。");}finally{pendingPreviews.decrementAndGet();}byte[] image=generated.bytes;
        synchronized(mutex){JSONObject info=file(id,authenticate(session));if(!source.isFile())throw new ApiError(404,"FILE_MISSING","文件已不在中转站中。");if(!checksum.equals(info.optString("sha256"))||size!=source.length()||modified!=source.lastModified())throw new ApiError(415,"PREVIEW_UNAVAILABLE","文件状态已变化，请重新预览。");}
        Response result=newFixedLengthResponse(status(200),"image/jpeg",new ByteArrayInputStream(session.getMethod()==Method.HEAD?new byte[0]:image),image.length);headers(result);result.addHeader("Cache-Control","private, no-store");result.addHeader("Content-Disposition","inline");result.addHeader("X-Preview-Pages",Integer.toString(generated.pages));result.addHeader("X-Preview-Page",Integer.toString(page));return result;
    }
    private Response textPreview(IHTTPSession session,String id)throws Exception{
        File source;String checksum;long size,modified;
        synchronized(mutex){JSONObject info=file(id,authenticate(session));if(!"text".equals(FilePool.previewKind(info)))throw new ApiError(415,"TEXT_PREVIEW_UNAVAILABLE","仅支持不超过 256 KiB 的文本文件预览。");source=ready(id);if(!source.isFile())throw new ApiError(404,"FILE_MISSING","文件已不在中转站中。");size=source.length();modified=source.lastModified();checksum=info.getString("sha256");if(size!=info.getLong("size"))throw new ApiError(422,"FILE_HASH_MISMATCH","文本文件大小已变化。");}
        if(pendingPreviews.incrementAndGet()>16){pendingPreviews.decrementAndGet();throw new ApiError(429,"PREVIEW_BUSY","预览请求较多，请稍后重试。");}
        try{byte[] sourceBytes;try(InputStream in=new FileInputStream(source)){sourceBytes=readAll(in,FilePool.MAX_TEXT_SOURCE);}
        if(sourceBytes.length!=size||!equal(hash(sourceBytes),checksum))throw new ApiError(422,"FILE_HASH_MISMATCH","文本完整性校验失败，未显示预览。");byte[] text;
        try{text=FilePool.decodeText(sourceBytes);}catch(IOException|RuntimeException error){throw new ApiError(415,"TEXT_ENCODING_UNSUPPORTED","文本编码暂不支持；请保存后查看。支持 UTF-8 和带 BOM 的 UTF-16。");}
        synchronized(mutex){JSONObject info=file(id,authenticate(session));if(!source.isFile()||source.length()!=size||source.lastModified()!=modified||!checksum.equals(info.optString("sha256")))throw new ApiError(422,"FILE_HASH_MISMATCH","文本文件状态已变化。");}
        Response result=newFixedLengthResponse(status(200),"text/plain; charset=utf-8",new ByteArrayInputStream(session.getMethod()==Method.HEAD?new byte[0]:text),text.length);headers(result);result.addHeader("Cache-Control","private, no-store");result.addHeader("Content-Security-Policy","default-src 'none'; sandbox");return result;}finally{pendingPreviews.decrementAndGet();}
    }
    private Response media(IHTTPSession s,String id)throws Exception{File source;String sha;long size;synchronized(mutex){JSONObject f=file(id,downloadDevice(s,id,"media"));if(FilePool.mediaMime(f)==null)throw new ApiError(415,"MEDIA_UNAVAILABLE","此媒体格式不支持在线播放。");source=ready(id);sha=f.getString("sha256");size=f.getLong("size");}try{previewIntegrity.verify(source,id,sha,size,MAX_FILE);}catch(IOException error){throw new ApiError(422,"FILE_HASH_MISMATCH","原件完整性校验失败，未播放媒体。");}synchronized(mutex){return download(s,id,true);}}
    private JSONObject downloadDevice(IHTTPSession s,String id,String purpose)throws Exception{
        String secret=s.getParms().get("ticket");JSONObject device;
        if(secret!=null){Ticket ticket=tickets.get(hash(secret));if(ticket==null||!id.equals(ticket.file)||!purpose.equals(ticket.purpose)||ticket.expires<=System.currentTimeMillis())throw new ApiError(401,"INVALID_TICKET","下载链接已过期，请重新点击下载。");device=byId("devices",ticket.device);if(device==null||device.optBoolean("revoked"))throw new ApiError(401,"AUTH_REVOKED","设备连接已撤销。");}else{if("media".equals(purpose))throw new ApiError(401,"INVALID_TICKET","媒体预览需要临时授权。");device=authenticate(s);}return device;
    }
    private Response download(IHTTPSession s,String id)throws Exception{return download(s,id,false);}
    private Response download(IHTTPSession s,String id,boolean media)throws Exception{
        JSONObject device=downloadDevice(s,id,media?"media":"download");
        JSONObject file=file(id,device);File source=ready(id);if(!source.isFile())throw new ApiError(404,"FILE_MISSING","文件已不在中转站中。");long size=source.length(),start=0,end=size-1;int status=200;String etag="\""+file.getString("sha256")+"\"",range=s.getHeaders().get("range"),ifRange=s.getHeaders().get("if-range");
        if(range!=null&&(ifRange==null||ifRange.equals(etag))){Matcher m=Pattern.compile("^bytes=([0-9]*)-([0-9]*)$").matcher(range);boolean invalid=!m.matches()||size==0;
            if(!invalid){try{if(m.group(1).isEmpty()){long suffix=Long.parseLong(m.group(2));invalid=suffix<=0;start=Math.max(0,size-suffix);}else{start=Long.parseLong(m.group(1));if(!m.group(2).isEmpty())end=Long.parseLong(m.group(2));}invalid|=start>=size||start>end;}catch(NumberFormatException e){invalid=true;}}
            if(invalid){Response r=response(416,object("error","下载范围无效。","code","INVALID_RANGE"));r.addHeader("Content-Range","bytes */"+size);return r;}end=Math.min(end,size-1);status=206;
        }
        long length=Math.max(0,end-start+1);InputStream input;
        if(s.getMethod()==Method.HEAD||length==0)input=new ByteArrayInputStream(new byte[0]);else{FileInputStream in=new FileInputStream(source);try{in.getChannel().position(start);}catch(IOException error){in.close();throw error;}input=new RevocableStream(new LimitedInputStream(in,length),device.getString("id"));}
        Response r=newFixedLengthResponse(status(status),media?FilePool.mediaMime(file):"application/octet-stream",input,length);headers(r);r.addHeader("Cache-Control","private, no-store");r.addHeader("Accept-Ranges","bytes");r.addHeader("ETag",etag);
        String name=file.getString("name"),ascii=name.replaceAll("[^\\x20-\\x7e]","_").replace('"','_').replace('\\','_');String encoded=URLEncoder.encode(name,"UTF-8").replace("+","%20").replace("*","%2A");r.addHeader("Content-Disposition",(media?"inline":"attachment")+"; filename=\""+ascii+"\"; filename*=UTF-8''"+encoded);
        if(status==206)r.addHeader("Content-Range","bytes "+start+"-"+end+"/"+size);return r;
    }
    private static final class LimitedInputStream extends FilterInputStream {
        long remaining;LimitedInputStream(InputStream in,long length){super(in);remaining=length;}
        @Override public int read()throws IOException{if(remaining<=0)return -1;int value=super.read();if(value>=0)remaining--;return value;}
        @Override public int read(byte[] data,int offset,int length)throws IOException{if(remaining<=0)return -1;int count=super.read(data,offset,(int)Math.min(length,remaining));if(count>0)remaining-=count;return count;}
    }
    private Response asset(IHTTPSession s)throws Exception{
        if(s.getMethod()!=Method.GET&&s.getMethod()!=Method.HEAD)throw new ApiError(405,"METHOD_NOT_ALLOWED","不支持此请求方式。");String uri=s.getUri(),name,mime;
        switch(uri){case"/":case"/index.html":name="index.html";mime="text/html; charset=utf-8";break;case"/app.js":name="app.js";mime="text/javascript; charset=utf-8";break;case"/convenience.css":name="convenience.css";mime="text/css; charset=utf-8";break;case"/pool-convenience.js":name="pool-convenience.js";mime="text/javascript; charset=utf-8";break;case"/pool-navigation.js":name="pool-navigation.js";mime="text/javascript; charset=utf-8";break;case"/pool-library.js":name="pool-library.js";mime="text/javascript; charset=utf-8";break;case"/pool.js":name="pool.js";mime="text/javascript; charset=utf-8";break;case"/sha256.js":name="sha256.js";mime="text/javascript; charset=utf-8";break;case"/qr.js":name="qr.js";mime="text/javascript; charset=utf-8";break;case"/styles.css":name="styles.css";mime="text/css; charset=utf-8";break;case"/favicon.svg":name="favicon.svg";mime="image/svg+xml";break;case"/icon.svg":name="icon.svg";mime="image/svg+xml";break;case"/manifest.webmanifest":name="manifest.webmanifest";mime="application/manifest+json";break;default:throw new ApiError(404,"NOT_FOUND","页面不存在。");}
        InputStream input;try{input=context.getAssets().open("web/"+name);}catch(IOException e){throw new ApiError(404,"NOT_FOUND","页面资源尚未安装。");}
        Response r=newChunkedResponse(status(200),mime,input);headers(r);r.addHeader("Cache-Control","no-cache");r.addHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");return r;
    }
}
