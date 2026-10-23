package app.relaydrop;

import android.content.Context;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

/** Private durable download journal. It never stores bearer tokens or download tickets. */
final class ReceiveQueueStore {
  interface Change {void apply(JSONObject job)throws Exception;}
  private static ReceiveQueueStore instance;
  static synchronized ReceiveQueueStore get(Context c)throws Exception{if(instance==null)instance=new ReceiveQueueStore(c.getApplicationContext());return instance;}
  final File directory;
  private final AtomicFile journal;
  private JSONArray jobs;
  private boolean uncertain;
  private ReceiveQueueStore(Context c)throws Exception{
    directory=new File(c.getFilesDir(),"incoming-v1");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("无法创建后台保存目录。");journal=new AtomicFile(new File(directory,"queue.json"));
    try(InputStream in=journal.openRead()){jobs=new JSONObject(new String(read(in),StandardCharsets.UTF_8)).getJSONArray("jobs");}catch(FileNotFoundException e){if(journal.getBaseFile().exists()||new File(journal.getBaseFile()+".bak").exists())throw e;jobs=new JSONArray();}
    for(int i=0;i<jobs.length();i++){JSONObject j=jobs.getJSONObject(i);id(j.getString("id"));String status=j.optString("status");if(status.equals("saving")||status.equals("waiting"))j.put("status","queued").put("nextAttemptAt",0);}
    persist(jobs);
  }
  private static byte[] read(InputStream in)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>8*1024*1024)throw new IOException("保存队列日志超过限制。");out.write(b,0,n);}return out.toByteArray();}
  private static String id(String v)throws IOException{if(v==null||!v.matches("[a-f0-9-]{36}"))throw new IOException("保存任务编号无效。");return v;}
  File payload(String v)throws IOException{return new File(directory,id(v)+".part");}
  static boolean terminal(String s){return "done".equals(s)||"cancelled".equals(s);}
  private void healthy()throws IOException{if(uncertain)throw new IOException("保存日志提交状态需要重启应用确认，已保留缓存与目标文件。");}
  synchronized JSONArray snapshot()throws Exception{healthy();return new JSONArray(jobs.toString());}
  synchronized JSONObject find(String v)throws Exception{healthy();for(int i=0;i<jobs.length();i++)if(v.equals(jobs.getJSONObject(i).optString("id")))return new JSONObject(jobs.getJSONObject(i).toString());throw new IOException("保存任务已不存在。");}
  synchronized void add(JSONArray incoming)throws Exception{int pending=0;JSONArray next=new JSONArray(jobs.toString());for(int i=0;i<next.length();i++)if(!terminal(next.getJSONObject(i).optString("status")))pending++;if(pending+incoming.length()>2500)throw new IOException("未完成保存任务超过2500项，请先处理已有任务。");for(int i=0;i<incoming.length();i++)next.put(incoming.getJSONObject(i));commit(next);}
  synchronized void change(String v,Change operation)throws Exception{JSONArray next=new JSONArray(jobs.toString());for(int i=0;i<next.length();i++){JSONObject j=next.getJSONObject(i);if(v.equals(j.optString("id"))){operation.apply(j);j.put("updatedAt",System.currentTimeMillis());commit(next);return;}}throw new IOException("保存任务已不存在。");}
  synchronized void trim()throws Exception{JSONArray next=new JSONArray(jobs.toString());java.util.Set<String> unfinished=new java.util.HashSet<>();for(int i=0;i<next.length();i++)if(!terminal(next.getJSONObject(i).optString("status")))unfinished.add(next.getJSONObject(i).optString("batchId"));int ended=0;for(int i=next.length()-1;i>=0;i--){JSONObject j=next.getJSONObject(i);if(terminal(j.optString("status"))&&++ended>100&&!j.has("cleanupUri")&&!("folder".equals(j.optString("kind"))&&unfinished.contains(j.optString("batchId"))))next.remove(i);}commit(next);}
  private void commit(JSONArray next)throws Exception{persist(next);jobs=next;}
  private void persist(JSONArray next)throws Exception{
    if(uncertain)throw new IOException("保存日志提交状态需要重启应用确认，已保留缓存与目标文件。");byte[] bytes=new JSONObject().put("version",1).put("jobs",next).toString().getBytes(StandardCharsets.UTF_8);if(bytes.length>8*1024*1024)throw new IOException("保存任务日志已满。");FileOutputStream out=null;boolean committed=false;
    try{out=journal.startWrite();out.write(bytes);out.getFD().sync();journal.finishWrite(out);out=null;committed=true;try(InputStream in=journal.openRead()){if(!java.util.Arrays.equals(bytes,read(in)))throw new IOException("保存日志读回校验失败。");}}
    catch(Exception error){if(out!=null)journal.failWrite(out);if(committed)uncertain=true;throw error;}
  }
}
