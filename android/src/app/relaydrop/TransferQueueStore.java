package app.relaydrop;

import android.content.Context;
import android.util.AtomicFile;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Durable native transfer journal. Credentials are referenced, never copied into this journal. */
final class TransferQueueStore {
  interface Change {void apply(JSONObject job)throws Exception;}
  private static TransferQueueStore instance;
  static synchronized TransferQueueStore get(Context context)throws Exception{if(instance==null)instance=new TransferQueueStore(context.getApplicationContext());return instance;}
  final File directory;
  private final AtomicFile journal;
  private static final int MAX_JOURNAL=32*1024*1024;
  private JSONArray jobs;
  private TransferQueueStore(Context context)throws Exception{
    directory=new File(context.getFilesDir(),"outgoing-v1");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("无法创建后台任务目录。");journal=new AtomicFile(new File(directory,"queue.json"));
    try(InputStream in=journal.openRead()){ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(bytes.size()+n>MAX_JOURNAL)throw new IOException("任务清单过大。");bytes.write(buffer,0,n);}JSONObject document=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));if(document.optInt("version")!=1)throw new IOException("后台任务格式无法识别，现有文件已保留。");jobs=document.getJSONArray("jobs");}
    catch(FileNotFoundException missing){if(journal.getBaseFile().exists()||new File(journal.getBaseFile()+".bak").exists())throw new IOException("后台任务日志暂不可读取，缓存已保留。",missing);jobs=new JSONArray();}
    boolean changed=false;for(int i=0;i<jobs.length();i++){JSONObject job=jobs.getJSONObject(i);String state=job.optString("status");if("sending".equals(state)||"waiting".equals(state)){job.put("status","queued");changed=true;}else if("importing".equals(state)){partial(job.getString("id")).delete();job.put("status","needs_source").put("error","文件尚未完整缓存，请重新分享原件。");changed=true;}else if("staged".equals(state)){File part=partial(job.getString("id")),ready=payload(job.getString("id"));if(!ready.isFile()&&part.isFile())part.renameTo(ready);job.put("status",ready.isFile()?(job.optBoolean("pauseAfterImport")?"paused":"queued"):"needs_source");changed=true;}}
    if(changed)persist();cleanup();
  }
  private String id(String id)throws IOException{if(id==null||!id.matches("[a-f0-9-]{36}"))throw new IOException("任务编号无效。");return id;}
  File payload(String id)throws IOException{return new File(directory,id(id)+".bin");}
  File partial(String id)throws IOException{return new File(directory,id(id)+".part");}
  synchronized JSONArray snapshot()throws Exception{return new JSONArray(jobs.toString());}
  synchronized JSONObject find(String id)throws Exception{for(int i=0;i<jobs.length();i++)if(id.equals(jobs.getJSONObject(i).optString("id")))return new JSONObject(jobs.getJSONObject(i).toString());return null;}
  synchronized void add(JSONArray incoming)throws Exception{
    int pending=0;for(int i=0;i<jobs.length();i++)if(!terminal(jobs.getJSONObject(i).optString("status")))pending++;if(pending+incoming.length()>2500)throw new IOException("后台任务最多保留 2,500 个未完成项目，请先完成或取消部分任务。");
    JSONArray next=new JSONArray(jobs.toString());for(int i=0;i<incoming.length();i++)next.put(new JSONObject(incoming.getJSONObject(i).toString()));persist(next);jobs=next;
  }
  synchronized void change(String id,Change change)throws Exception{JSONArray next=new JSONArray(jobs.toString());for(int i=0;i<next.length();i++){JSONObject job=next.getJSONObject(i);if(id.equals(job.optString("id"))){change.apply(job);job.put("updatedAt",System.currentTimeMillis());persist(next);jobs=next;return;}}}
  static boolean terminal(String value){return "done".equals(value)||"cancelled".equals(value);}
  synchronized void trim()throws Exception{cleanup();JSONArray next=new JSONArray(jobs.toString());int ended=0;for(int i=next.length()-1;i>=0;i--){if(terminal(next.getJSONObject(i).optString("status"))&&++ended>50)next.remove(i);}persist(next);jobs=next;}
  private void cleanup()throws Exception{Set<String> keep=new HashSet<>();for(int i=0;i<jobs.length();i++){JSONObject j=jobs.getJSONObject(i);if(!terminal(j.optString("status"))&&!"needs_source".equals(j.optString("status")))keep.add(id(j.getString("id")));}File[] files=directory.listFiles();if(files!=null)for(File file:files){String name=file.getName();if(file.isFile()&&name.matches("[a-f0-9-]{36}\\.(bin|part)")&&!keep.contains(name.substring(0,36)))file.delete();}}
  private void persist()throws Exception{persist(jobs);}
  private void persist(JSONArray next)throws Exception{byte[] bytes=new JSONObject().put("version",1).put("jobs",next).toString().getBytes(StandardCharsets.UTF_8);if(bytes.length>MAX_JOURNAL)throw new IOException("任务清单已满，请先取消部分任务。");FileOutputStream out=null;try{out=journal.startWrite();out.write(bytes);out.getFD().sync();journal.finishWrite(out);out=null;try(InputStream in=journal.openRead()){byte[] block=new byte[8192];int at=0,n;while((n=in.read(block))!=-1){if(n>bytes.length-at)throw new IOException("任务日志写入校验失败，原件已保留。");for(int i=0;i<n;i++)if(block[i]!=bytes[at+i])throw new IOException("任务日志写入校验失败，原件已保留。");at+=n;}if(at!=bytes.length)throw new IOException("任务日志未完整写入，原件已保留。");}}catch(Exception e){if(out!=null)journal.failWrite(out);throw e;}}
}
