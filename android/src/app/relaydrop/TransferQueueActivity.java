package app.relaydrop;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.os.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.util.*;

public final class TransferQueueActivity extends SecureActivity {
  private final Handler handler=new Handler(Looper.getMainLooper());
  private final Map<String,Row> rows=new LinkedHashMap<>();
  private LinearLayout list;
  private TextView summary;
  private boolean visible;
  private final Runnable refresh=new Runnable(){public void run(){if(!visible)return;render();handler.postDelayed(this,1000);}};
  private int dp(int n){return (int)(getResources().getDisplayMetrics().density*n+.5f);}
  private TextView text(String value,int size){TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(Color.rgb(20,44,53));t.setPadding(0,dp(5),0,dp(5));return t;}
  private Button button(String value,Runnable action){Button b=new Button(this);b.setText(value);b.setAllCaps(false);b.setOnClickListener(v->action.run());return b;}
  @Override public void onCreate(Bundle state){super.onCreate(state);ScrollView scroll=new ScrollView(this);scroll.setBackgroundColor(Color.rgb(244,247,246));LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(dp(20),dp(28),dp(20),dp(24));root.setOnApplyWindowInsetsListener((v,i)->{root.setPadding(dp(20),dp(20)+i.getSystemWindowInsetTop(),dp(20),dp(24)+i.getSystemWindowInsetBottom());return i;});scroll.addView(root);setContentView(scroll);root.addView(text("后台传输",27));root.addView(text("原件缓存完成后，可以离开页面。暂停后保留原件与上传断点；系统强制停止应用后，需重新打开继续。",14));summary=text("正在读取任务…",14);root.addView(summary);LinearLayout controls=new LinearLayout(this);controls.addView(button("暂停全部",()->act(UploadQueueService.PAUSE,null)));controls.addView(button("恢复全部",()->act(UploadQueueService.RESUME,null)));controls.addView(button("首页",()->startActivity(new Intent(this,MainActivity.class))));root.addView(controls);list=new LinearLayout(this);list.setOrientation(1);root.addView(list);}
  private void act(String action,String id){try{UploadQueueService.control(this,action,id);}catch(Exception e){Toast.makeText(this,UploadQueueService.message(e),Toast.LENGTH_LONG).show();}}
  private static String status(String state){switch(state){case "importing":return "正在缓存原件";case "staged":return "原件已缓存";case "queued":return "等待发送";case "sending":return "正在发送并校验";case "waiting":return "等待重连，将自动重试";case "paused":return "已暂停，原件和断点保留";case "blocked":return "身份校验未通过";case "needs_source":return "需要重新分享原件";case "done":return "已送达并校验";case "cancelled":return "已取消";default:return "需要处理";}}
  private void render(){try{JSONArray jobs=TransferQueueStore.get(this).snapshot();int active=0,complete=0,position=0;Set<String> current=new HashSet<>();for(int i=jobs.length()-1;i>=0;i--){JSONObject job=jobs.getJSONObject(i);String id=job.getString("id"),state=job.optString("status");current.add(id);if("done".equals(state))complete++;else if(!"cancelled".equals(state))active++;Row row=rows.get(id);if(row==null){row=new Row(id);rows.put(id,row);list.addView(row.box,position);}else if(list.indexOfChild(row.box)!=position){list.removeView(row.box);list.addView(row.box,position);}position++;row.title.setText(job.optString("name","文件"));String detail=status(state)+" · "+job.optString("destination","中转站");if(job.optLong("size")>0&&!TransferQueueStore.terminal(state))detail+="\n"+job.optLong("offset")/1024+" / "+job.optLong("size")/1024+" KiB";if(job.optBoolean("pauseAfterImport")&&"importing".equals(state))detail+="\n原件缓存完成后暂停上传";if(!job.isNull("error")&&!job.optString("error").isEmpty())detail+="\n"+job.optString("error");if(job.has("resultNote"))detail+="\n"+job.optString("resultNote");row.detail.setText(detail);boolean running=Arrays.asList("importing","staged","queued","sending","waiting").contains(state);row.action.setText(running?"暂停":"恢复");row.action.setEnabled(!TransferQueueStore.terminal(state)&&!"needs_source".equals(state)&&!"blocked".equals(state));row.action.setOnClickListener(v->act(running?UploadQueueService.PAUSE:UploadQueueService.RESUME,id));row.cancel.setEnabled(!TransferQueueStore.terminal(state));}
    Iterator<Map.Entry<String,Row>> it=rows.entrySet().iterator();while(it.hasNext()){Map.Entry<String,Row> e=it.next();if(!current.contains(e.getKey())){list.removeView(e.getValue().box);it.remove();}}summary.setText(jobs.length()==0?"暂无后台任务。从系统分享菜单或文件传送页的“后台发送文件”加入。":"待处理 "+active+" 项 · 已完成 "+complete+" 项");
  }catch(Exception e){summary.setText(UploadQueueService.message(e));}}
  private final class Row{final LinearLayout box;final TextView title,detail;final Button action,cancel;Row(String id){box=new LinearLayout(TransferQueueActivity.this);box.setOrientation(1);box.setPadding(dp(14),dp(16),dp(14),dp(16));title=text("",17);detail=text("",13);box.addView(title);box.addView(detail);LinearLayout buttons=new LinearLayout(TransferQueueActivity.this);action=button("暂停",()->{});cancel=button("取消",()->new AlertDialog.Builder(TransferQueueActivity.this).setTitle("取消这项任务？").setMessage("本机缓存将清理，已经送达中转站的内容会保留。").setNegativeButton("返回",null).setPositiveButton("取消任务",(d,w)->act(UploadQueueService.CANCEL,id)).show());buttons.addView(action);buttons.addView(cancel);box.addView(buttons);}}
  @Override protected void onStart(){super.onStart();visible=true;handler.post(refresh);try{UploadQueueService.control(this,UploadQueueService.WAKE,null);}catch(Exception ignored){}}
  @Override protected void onStop(){visible=false;handler.removeCallbacks(refresh);super.onStop();}
}
