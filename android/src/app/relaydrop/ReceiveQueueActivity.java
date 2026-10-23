package app.relaydrop;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.MimeTypeMap;
import android.widget.*;
import org.json.*;
import java.util.*;

/** Durable saved-file history, including direct open/share of verified destination documents. */
public final class ReceiveQueueActivity extends SecureActivity {
  private final Handler handler=new Handler(Looper.getMainLooper());
  private final Map<String,Row> rows=new LinkedHashMap<>();
  private LinearLayout list;
  private TextView summary;
  private boolean visible;
  private final Runnable refresh=new Runnable(){public void run(){if(!visible)return;render();handler.postDelayed(this,1000);}};
  private int dp(int n){return (int)(getResources().getDisplayMetrics().density*n+.5f);}
  private TextView text(String s,int size){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(Color.rgb(20,44,53));t.setPadding(0,dp(6),0,dp(6));return t;}
  private Button button(String s,Runnable action){Button b=new Button(this);b.setText(s);b.setAllCaps(false);b.setOnClickListener(v->action.run());return b;}
  @Override public void onCreate(Bundle state){super.onCreate(state);ScrollView scroll=new ScrollView(this);scroll.setBackgroundColor(Color.rgb(244,247,246));LinearLayout box=new LinearLayout(this);box.setOrientation(1);box.setPadding(dp(20),dp(20),dp(20),dp(20));box.setOnApplyWindowInsetsListener((v,i)->{box.setPadding(dp(20),dp(20)+i.getSystemWindowInsetTop(),dp(20),dp(20)+i.getSystemWindowInsetBottom());return i;});scroll.addView(box);setContentView(scroll);box.addView(text("后台保存 / 最近保存",25));box.addView(text("一次选择目录，整批后台保存。离开页面仍继续；每个文件完成原件校验和落盘读回后才标为完成。同名文件另存，不覆盖。强制停止应用后需重新打开继续。",14));summary=text("正在读取…",14);box.addView(summary);LinearLayout buttons=new LinearLayout(this);buttons.addView(button("暂停全部",()->act(ReceiveQueueService.PAUSE,null)));buttons.addView(button("恢复全部",()->act(ReceiveQueueService.RESUME,null)));buttons.addView(button("返回",this::finish));box.addView(buttons);list=new LinearLayout(this);list.setOrientation(1);box.addView(list);}
  private void act(String action,String id){try{ReceiveQueueService.control(this,action,id);}catch(Exception e){Toast.makeText(this,UploadQueueService.message(e),Toast.LENGTH_LONG).show();}}
  private String status(String s){switch(s){case "queued":return "等待保存";case "saving":return "下载 / 写入并读回校验";case "waiting":return "等待网络恢复，自动重试";case "paused":return "已暂停，下载断点保留";case "blocked":return "设备身份校验未通过";case "done":return "已保存并读回校验";case "cancelled":return "已取消";default:return "保存未完成，请处理后恢复";}}
  private void render(){try{JSONArray jobs=ReceiveQueueStore.get(this).snapshot();Set<String> keep=new HashSet<>();int count=0,done=0,position=0;for(int i=jobs.length()-1;i>=0;i--){JSONObject j=jobs.getJSONObject(i);String id=j.getString("id"),state=j.optString("status");keep.add(id);if("done".equals(state))done++;else if(!"cancelled".equals(state))count++;Row row=rows.get(id);if(row==null){row=new Row();rows.put(id,row);list.addView(row.box,position);}else if(list.indexOfChild(row.box)!=position){list.removeView(row.box);list.addView(row.box,position);}position++;row.title.setText(j.optString("savedName",j.optString("name","文件")));String detail=status(state)+" · "+j.optString("source","文件池");if(!ReceiveQueueStore.terminal(state))detail+="\n"+j.optLong("offset")/1024+" / "+j.optLong("size")/1024+" KiB";if(j.has("error"))detail+="\n"+j.optString("error");detail+="\n保存目录："+Uri.decode(Uri.parse(j.optString("tree")).getLastPathSegment());row.detail.setText(detail);boolean folder="folder".equals(j.optString("kind")),complete="done".equals(state),running=Arrays.asList("saving","queued","waiting").contains(state);row.first.setText(complete?(folder?"目录已建立":"打开"):running?"暂停":"恢复");row.first.setEnabled(!(complete&&folder)&&!"cancelled".equals(state)&&!"blocked".equals(state));row.first.setOnClickListener(v->{if(complete)open(j,false);else act(running?ReceiveQueueService.PAUSE:ReceiveQueueService.RESUME,id);});row.second.setText(complete?"分享":"取消");row.second.setEnabled(!(complete&&folder)&&!"cancelled".equals(state));row.second.setOnClickListener(v->{if(complete)open(j,true);else new AlertDialog.Builder(this).setTitle("取消保存？").setMessage("会清理该任务的未完成缓存和新建未完成文件；已完成的文件保留。").setNegativeButton("返回",null).setPositiveButton("取消保存",(d,w)->act(ReceiveQueueService.CANCEL,id)).show();});}
    Iterator<Map.Entry<String,Row>> it=rows.entrySet().iterator();while(it.hasNext()){Map.Entry<String,Row> e=it.next();if(!keep.contains(e.getKey())){list.removeView(e.getValue().box);it.remove();}}summary.setText(jobs.length()==0?"暂无保存记录。在文件池选择文件，点击保存即可。":"待处理 "+count+" 项 · 最近完成 "+done+" 项（保留最近100条结果）");String pendingMessage=getSharedPreferences("incoming-status",MODE_PRIVATE).getString("message","");if(!pendingMessage.isEmpty())summary.append("\n"+pendingMessage);}catch(Exception e){summary.setText(UploadQueueService.message(e));}}
  private boolean opening;
  private void open(JSONObject job,boolean share){if(opening)return;opening=true;Toast.makeText(this,"正在核验本机副本…",Toast.LENGTH_SHORT).show();new Thread(()->{try{SavedCopies.verify(this,job,()->{if(isDestroyed()||isFinishing())throw new java.io.IOException("页面已关闭。");});runOnUiThread(()->{opening=false;if(isDestroyed()||isFinishing())return;try{SavedCopies.launch(this,job,share);}catch(Exception e){Toast.makeText(this,"没有可用的打开应用，或保存位置授权已失效。",Toast.LENGTH_LONG).show();}});}catch(Exception e){runOnUiThread(()->{opening=false;if(!isDestroyed())Toast.makeText(this,"本机文件已改变、移动或授权失效，请到保存目录检查。",Toast.LENGTH_LONG).show();});}},"relay-saved-history-open").start();}
  private final class Row{final LinearLayout box;final TextView title,detail;final Button first,second;Row(){box=new LinearLayout(ReceiveQueueActivity.this);box.setOrientation(1);box.setPadding(dp(8),dp(16),dp(8),dp(16));title=text("",17);detail=text("",13);box.addView(title);box.addView(detail);LinearLayout buttons=new LinearLayout(ReceiveQueueActivity.this);first=button("",()->{});second=button("",()->{});buttons.addView(first);buttons.addView(second);box.addView(buttons);}}
  @Override protected void onStart(){super.onStart();visible=true;handler.post(refresh);try{ReceiveQueueService.control(this,ReceiveQueueService.WAKE,null);}catch(Exception ignored){}}
  @Override protected void onStop(){visible=false;handler.removeCallbacks(refresh);super.onStop();}
}
