package app.relaydrop;
import android.content.Context;
import org.json.*;

/** Only queue rows bound to this authorized pool and paired device leave native storage. */
final class NativeTasks {
  static void action(Context context,JSONObject state,String expected,String id,String kind,String action)throws Exception {if(AppLock.isLocked(context)||!SavedCopies.context(state).equals(expected)||id==null||!id.matches("[a-fA-F0-9-]{36}")||!java.util.Arrays.asList("upload","save").contains(kind)||!java.util.Arrays.asList("pause","resume","cancel").contains(action))throw new java.io.IOException("任务操作未获授权。");JSONObject job="save".equals(kind)?ReceiveQueueStore.get(context).find(id):TransferQueueStore.get(context).find(id);JSONObject security=state.getJSONObject("security");if(job==null||!security.getString("serverId").equals(job.optString("serverId"))||!security.getString("certificateFingerprint").equals(job.optString("fingerprint"))||!state.getJSONObject("device").getString("id").equals(job.optString("deviceId")))throw new java.io.IOException("此任务不属于当前文件池身份。");String command=action.toUpperCase(java.util.Locale.ROOT);if("save".equals(kind))ReceiveQueueService.control(context,command,id);else UploadQueueService.control(context,command,id);}
  static JSONObject list(Context context,JSONObject state,String expected)throws Exception{
    if(!SavedCopies.context(state).equals(expected))throw new java.io.IOException("文件池身份已改变。");JSONArray rows=new JSONArray();String server=state.getJSONObject("security").getString("serverId"),pin=state.getJSONObject("security").getString("certificateFingerprint"),device=state.getJSONObject("device").getString("id");
    append(rows,TransferQueueStore.get(context).snapshot(),"upload",server,pin,device);append(rows,ReceiveQueueStore.get(context).snapshot(),"save",server,pin,device);return new JSONObject().put("context",expected).put("tasks",rows);
  }
  private static void append(JSONArray rows,JSONArray jobs,String kind,String server,String pin,String device)throws Exception{
    for(int i=jobs.length()-1;i>=0&&rows.length()<200;i--){JSONObject job=jobs.getJSONObject(i);if(!server.equals(job.optString("serverId"))||!pin.equals(job.optString("fingerprint"))||!device.equals(job.optString("deviceId")))continue;String status=job.optString("status");boolean terminal="done".equals(status)||"cancelled".equals(status);if(terminal&&System.currentTimeMillis()-job.optLong("completedAt",job.optLong("createdAt"))>86400000L)continue;JSONObject row=new JSONObject().put("id",job.getString("id")).put("kind",kind).put("status",status).put("name",job.optString("name","文件")).put("doneBytes",Math.max(0,job.optLong("offset"))).put("totalBytes",Math.max(0,job.optLong("size")));for(String key:new String[]{"fileId","folderId"})if(job.has(key)&&!job.isNull(key))row.put(key,job.getString(key));if(job.has("error")&&!job.isNull("error"))row.put("error","请在后台任务页查看详情并处理");rows.put(row);}
  }
}
