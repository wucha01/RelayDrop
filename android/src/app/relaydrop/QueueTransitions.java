package app.relaydrop;
import org.json.JSONObject;
/** All decisions use the job held inside the journal's synchronized transaction. */
final class QueueTransitions {
  static boolean control(JSONObject job,String action)throws Exception{String state=job.optString("status");if(TransferQueueStore.terminal(state))return false;
    if("PAUSE".equals(action)){if("importing".equals(state)||"staged".equals(state)){job.put("pauseAfterImport",true);return false;}if(!"needs_source".equals(state)){job.put("status","paused");return true;}}
    if("RESUME".equals(action)){if("importing".equals(state)||"staged".equals(state))job.put("pauseAfterImport",false);else if(!"needs_source".equals(state)&&!"sending".equals(state)&&!"queued".equals(state))job.put("status","queued").put("nextAttemptAt",0).put("error",JSONObject.NULL);}
    if("CANCEL".equals(action)){job.put("status","cancelled").put("error","已取消，本机缓存已清理。已送达的内容会保留。");return true;}return false;
  }
  static boolean mayFail(JSONObject job){String state=job.optString("status");return !TransferQueueStore.terminal(state)&&!"paused".equals(state);}
}
