package app.relaydrop;

import android.app.Activity;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.webkit.MimeTypeMap;
import java.io.*;
import java.util.*;
import org.json.*;

/** Private receipts contain no credentials; web callers never choose a local path or URI. */
final class SavedCopies {
  private static final Object LOCK=new Object();
  private static final int MAX_BYTES=24*1024*1024;
  private static volatile String diagnostic="";
  static String diagnostic(){return diagnostic;}
  private static boolean valid(JSONObject r){if(r==null)return false;String uri=r.optString("destinationUri"),hash=r.optString("sha256");return uri.length()<=4096&&"content".equals(Uri.parse(uri).getScheme())&&Uri.parse(uri).getAuthority()!=null&&hash.matches("[a-f0-9]{64}")&&r.optLong("size",-1)>=0&&r.optLong("size")<=20L*1024*1024*1024&&r.optString("name").length()<=255&&r.optString("savedName").length()<=255&&r.optString("source").length()<=256;}
  static ArrayList<JSONObject> allLocal(Context context)throws Exception {synchronized(LOCK){ArrayList<JSONObject> result=new ArrayList<>();Set<String> seen=new HashSet<>();for(JSONObject r:receipts(context))if(r.has("destinationUri")&&r.optString("sha256").matches("[a-f0-9]{64}")&&seen.add(r.optString("destinationUri")+"|"+r.optString("sha256")))result.add(new JSONObject(r.toString()));JSONArray jobs=ReceiveQueueStore.get(context).snapshot();for(int i=jobs.length()-1;i>=0;i--){JSONObject r=jobs.optJSONObject(i);if(valid(r)&&"done".equals(r.optString("status"))&&r.has("destinationUri")&&r.optString("sha256").matches("[a-f0-9]{64}")&&seen.add(r.optString("destinationUri")+"|"+r.optString("sha256")))result.add(new JSONObject(r.toString()));}result.sort((a,b)->Long.compare(b.optLong("completedAt"),a.optLong("completedAt")));return result;}}
  static void remember(Context context,JSONObject job)throws Exception {
    if(!"done".equals(job.optString("status"))||job.optString("deviceId").isEmpty())return;
    JSONObject receipt=new JSONObject();for(String key:new String[]{"serverId","fingerprint","deviceId","fileId","sha256","size","destinationUri","savedName","name","source","completedAt"})if(job.has(key))receipt.put(key,job.get(key));
    long[] stat=stat(context,receipt);receipt.put("verifiedSize",stat[0]).put("verifiedModified",stat[1]);
    if(!valid(receipt))throw new IOException("保存记录超出格式限制，原件仍在所选目录。");synchronized(LOCK){JSONArray next=new JSONArray().put(receipt);int bytes=receipt.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length+2;Set<String> seen=new HashSet<>();seen.add(key(receipt));for(JSONObject old:receipts(context)){if(next.length()>=50000)break;if(seen.add(key(old))){int length=old.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length+1;if(bytes+length>MAX_BYTES){diagnostic="记录达到容量上限；较早副本仍在原保存目录。";break;}next.put(old);bytes+=length;}}if(diagnostic.startsWith("记录清单损坏")||diagnostic.startsWith("记录清单过大"))throw new IOException(diagnostic);if(!context.getSharedPreferences("saved-copies-v1",Context.MODE_PRIVATE).edit().putString("receipts",next.toString()).commit())throw new IOException("无法记住本机副本，原件仍保存在所选目录。");}
  }
  private static String key(JSONObject a){StringBuilder key=new StringBuilder();for(String part:new String[]{"serverId","fingerprint","deviceId","fileId","sha256"})key.append(a.optString(part)).append('|');return key.toString();}
  private static ArrayList<JSONObject> receipts(Context c)throws Exception {
    ArrayList<JSONObject> result=new ArrayList<>();String raw=c.getSharedPreferences("saved-copies-v1",Context.MODE_PRIVATE).getString("receipts","[]");diagnostic="";if(raw.length()>MAX_BYTES||raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>MAX_BYTES)diagnostic="记录清单过大，已保留原记录并显示最近保存历史。";else try{JSONArray rows=new JSONArray(raw);int skipped=0;for(int i=0;i<rows.length()&&i<50000;i++){JSONObject value=rows.optJSONObject(i);if(valid(value))result.add(value);else skipped++;}if(skipped>0)diagnostic="已跳过 "+skipped+" 条不完整记录；已保存原件未删除。";}catch(JSONException corrupt){diagnostic="记录清单损坏，已保留原记录并显示最近保存历史。";}
    // A completed journal remains a safe fallback if a receipt commit was interrupted.
    JSONArray jobs=ReceiveQueueStore.get(c).snapshot();for(int i=jobs.length()-1;i>=0;i--){JSONObject j=jobs.optJSONObject(i);if(valid(j)&&"done".equals(j.optString("status"))&&!j.optString("deviceId").isEmpty())result.add(j);}return result;
  }
  static String context(JSONObject state)throws Exception{return state.getJSONObject("security").getString("serverId")+":"+state.getJSONObject("device").getString("id");}
  static JSONObject receipt(Context c,JSONObject state,String fileId,String sha)throws Exception {
    synchronized(LOCK){return find(receipts(c),state,fileId,sha);}
  }
  private static JSONObject find(ArrayList<JSONObject> candidates,JSONObject state,String fileId,String sha)throws Exception {
    JSONObject file=ReceiveQueueService.visibleFile(state,fileId);if(!sha.equals(file.getString("sha256")))throw new IOException("原件内容已改变，请刷新文件池。");JSONObject sec=state.getJSONObject("security");String device=state.getJSONObject("device").getString("id");
    for(JSONObject r:candidates)if(sec.getString("serverId").equals(r.optString("serverId"))&&sec.getString("certificateFingerprint").equals(r.optString("fingerprint"))&&device.equals(r.optString("deviceId"))&&fileId.equals(r.optString("fileId"))&&sha.equals(r.optString("sha256"))&&file.getLong("size")==r.optLong("size",-1))return new JSONObject(r.toString());return null;
  }
  private static long[] stat(Context c,JSONObject receipt)throws Exception {
    Uri uri=Uri.parse(receipt.getString("destinationUri"));if(!"content".equals(uri.getScheme()))throw new IOException("本机副本位置无效。");
    try(android.os.ParcelFileDescriptor fd=c.getContentResolver().openFileDescriptor(uri,"r")){if(fd==null)throw new FileNotFoundException();}
    try(Cursor cursor=c.getContentResolver().query(uri,new String[]{DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_LAST_MODIFIED},null,null,null)){if(cursor==null||!cursor.moveToFirst())throw new FileNotFoundException();return new long[]{cursor.isNull(0)?-1:cursor.getLong(0),cursor.isNull(1)?0:cursor.getLong(1)};}
  }
  static void verify(Context c,JSONObject receipt)throws Exception {
    verify(c,receipt,()->{});
  }
  static void verify(Context c,JSONObject receipt,FileIntegrity.Check check)throws Exception {
    byte[] hash=new byte[32];String sha=receipt.getString("sha256");if(!sha.matches("[a-f0-9]{64}"))throw new IOException("副本校验记录无效。");for(int i=0;i<32;i++)hash[i]=(byte)Integer.parseInt(sha.substring(i*2,i*2+2),16);
    try(InputStream in=c.getContentResolver().openInputStream(Uri.parse(receipt.getString("destinationUri")))){if(in==null)throw new FileNotFoundException();FileIntegrity.require(FileIntegrity.read(in,receipt.getLong("size"),check),new FileIntegrity.Value(receipt.getLong("size"),hash));}
    catch(FileIntegrity.Mismatch changed){synchronized(LOCK){try{JSONArray next=new JSONArray();Set<String> seen=new HashSet<>();for(JSONObject r:receipts(c)){if(!seen.add(key(r))||next.length()>=50000)continue;if(key(r).equals(key(receipt)))r.put("verifiedSize",-1).put("verifiedModified",-1);next.put(r);}if(!diagnostic.startsWith("记录清单损坏")&&!diagnostic.startsWith("记录清单过大")&&next.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length<=MAX_BYTES)c.getSharedPreferences("saved-copies-v1",Context.MODE_PRIVATE).edit().putString("receipts",next.toString()).commit();}catch(Exception ignored){}}throw changed;}
  }
  static JSONObject list(Context c,JSONObject state,String expected,JSONArray requested)throws Exception {
    if(!context(state).equals(expected)||requested.length()>100)throw new IOException("文件池身份或查询数量无效。");JSONArray result=new JSONArray();Set<String> ids=new HashSet<>();ArrayList<JSONObject> candidates;synchronized(LOCK){candidates=receipts(c);}
    for(int i=0;i<requested.length();i++){JSONObject item=requested.getJSONObject(i);String id=item.getString("id"),sha=item.getString("sha256");if(!id.matches("[a-fA-F0-9-]{36}")||!sha.matches("[a-f0-9]{64}")||!ids.add(id))throw new IOException("本机副本查询无效。");JSONObject receipt=find(candidates,state,id,sha);if(receipt==null)continue;String status;
      try{long[] meta=stat(c,receipt);if(meta[0]>=0&&meta[0]!=receipt.getLong("size"))status="changed";else if(meta[1]>0&&meta[0]==receipt.optLong("verifiedSize",-1)&&meta[1]==receipt.optLong("verifiedModified",-1))status="saved";else{verify(c,receipt);status="saved";JSONObject verified=new JSONObject(receipt.toString()).put("status","done");remember(c,verified);}}catch(FileIntegrity.Mismatch changed){status="changed";}catch(FileNotFoundException missing){status="missing";}catch(SecurityException denied){status="unavailable";}catch(Exception error){status="unavailable";}
      result.put(new JSONObject().put("id",id).put("sha256",sha).put("status",status).put("savedAt",receipt.optLong("completedAt")));
    }return new JSONObject().put("context",expected).put("files",result);
  }
  static void launch(Activity activity,JSONObject receipt,boolean share)throws Exception {
    if(AppLock.isLocked(activity))throw new IOException("界面已锁定。");String filename=receipt.optString("savedName",receipt.optString("name","")).toLowerCase(Locale.ROOT);if(!share&&filename.matches(".*\\.(apk|xapk|apks|exe|msi|msix|appx|com|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|reg|sh|jar)$")){new android.app.AlertDialog.Builder(activity).setTitle("此文件可能安装或运行程序").setMessage(filename+"\n\nSHA-256 校验只确认副本与原件一致，不代表文件安全。仅在你信任来源并知道用途时继续。").setNegativeButton("取消",null).setPositiveButton("我确认来源，继续打开",(d,w)->{try{launchUnchecked(activity,receipt,false);}catch(Exception e){android.widget.Toast.makeText(activity,"无法打开此文件",android.widget.Toast.LENGTH_LONG).show();}}).show();return;}launchUnchecked(activity,receipt,share);
  }
  private static void launchUnchecked(Activity activity,JSONObject receipt,boolean share)throws Exception {
    if(AppLock.isLocked(activity))throw new IOException("界面已锁定。");
    Uri uri=Uri.parse(receipt.getString("destinationUri"));String name=receipt.optString("savedName",receipt.optString("name","文件")),ext=name.contains(".")?name.substring(name.lastIndexOf('.')+1).toLowerCase(Locale.ROOT):"",mime=MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);if(mime==null)mime="application/octet-stream";
    Intent intent=share?new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM,uri):new Intent(Intent.ACTION_VIEW).setDataAndType(uri,mime);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).setClipData(ClipData.newUri(activity.getContentResolver(),name,uri));activity.startActivity(Intent.createChooser(intent,share?"分享已保存原件":"打开已保存文件"));
  }
}
