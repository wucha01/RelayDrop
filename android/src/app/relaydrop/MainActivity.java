package app.relaydrop;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.nsd.*;
import android.net.wifi.WifiManager;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import java.net.*;
import java.util.*;

public class MainActivity extends SecureActivity {
  private final Handler handler=new Handler(Looper.getMainLooper());
  private LinearLayout root,discovered;
  private TextView status,addresses;
  private Button launch;
  private boolean openWhenReady=false;
  private NsdManager nsd;
  private NsdManager.DiscoveryListener discovery;
  private WifiManager.MulticastLock multicast;
  private final Set<String> found=new HashSet<>();
  private final ArrayDeque<NsdServiceInfo> resolveQueue=new ArrayDeque<>();
  private final Map<String,View> serviceViews=new HashMap<>();
  private final Map<String,String> serviceUrls=new HashMap<>();
  private int discoveryGeneration=0;
  private boolean resolving=false,active=false;
  private TextView discoveryMessage;
  private final int ink=Color.rgb(20,44,53),teal=Color.rgb(12,130,118),muted=Color.rgb(96,115,120);
  private final Runnable refresh=new Runnable(){public void run(){if(!active)return;update();if(active)handler.postDelayed(this,1000);}};
  int dp(float v){return (int)(getResources().getDisplayMetrics().density*v+.5f);}
  GradientDrawable shape(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
  TextView text(String value,int size,int color,boolean bold){TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);if(bold)t.setTypeface(null,Typeface.BOLD);t.setLineSpacing(dp(3),1);return t;}
  void add(LinearLayout parent,View view,int top){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(top);parent.addView(view,p);}
  LinearLayout card(){LinearLayout c=new LinearLayout(this);c.setOrientation(1);c.setPadding(dp(22),dp(22),dp(22),dp(22));c.setBackground(shape(Color.WHITE,20));add(root,c,16);return c;}
  Button button(String label,boolean primary,Runnable action){Button b=new Button(this);b.setText(label);b.setAllCaps(false);b.setTextSize(15);b.setTextColor(primary?Color.WHITE:teal);b.setBackground(shape(primary?teal:Color.rgb(232,243,240),12));b.setPadding(dp(16),dp(12),dp(16),dp(12));b.setOnClickListener(v->action.run());return b;}
  @Override public void onCreate(Bundle state){
    super.onCreate(state);
    ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(Color.rgb(244,247,246));
    root=new LinearLayout(this);root.setOrientation(1);root.setPadding(dp(22),dp(28),dp(22),dp(28));scroll.addView(root);setContentView(scroll);
    scroll.setOnApplyWindowInsetsListener((v,insets)->{root.setPadding(dp(22),dp(24)+insets.getSystemWindowInsetTop(),dp(22),dp(24)+insets.getSystemWindowInsetBottom());return insets;});
    add(root,text("↗  星月夜",28,ink,true),0);add(root,text("隔空中转站  /  ANDROID",12,teal,true),4);
    add(root,text("设备之间，\n轻松抵达。",36,ink,true),30);
    add(root,text("手机 · 平板 · 电脑\n文件和文字留在你的设备之间。",16,muted,false),10);
    LinearLayout host=card();add(host,text("01  创建中转站",20,ink,true),0);
    add(host,text("这台安卓设备负责保存和中转文件。另一台设备连接同一 Wi-Fi 或热点后，即可扫码加入，无需电脑。",14,muted,false),10);
    status=text("尚未启动",14,teal,true);add(host,status,14);
    addresses=text("",13,muted,false);addresses.setTextIsSelectable(true);add(host,addresses,6);
    launch=button("创建中转站并打开",true,()->{
      if(RelayService.server!=null){openHost();return;}
      if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},15);
      openWhenReady=true;try{startForegroundService(new Intent(this,RelayService.class));status.setText("正在启动…");launch.setEnabled(false);}catch(Exception e){openWhenReady=false;status.setText("无法启动中转站，请回到应用前台后重试。");}
    });add(host,launch,14);
    add(host,button("文件池备份与迁移",false,()->startActivity(new Intent(this,StorageActivity.class))),10);
    add(host,button("暂停 / 恢复对外共享",false,this::sharingDialog),10);
    add(host,button("锁定应用界面",false,()->AppLock.lock(this)),10);
    add(host,button("本机文件 · 离线打开",false,()->startActivity(new Intent(this,LocalFilesActivity.class))),10);
    add(host,button("停止中转站",false,()->new AlertDialog.Builder(this).setTitle("停止中转站？").setMessage("当前传输会中断，已完成文件和上传断点会保留。").setNegativeButton("取消",null).setPositiveButton("停止",(d,w)->{openWhenReady=false;stopService(new Intent(this,RelayService.class));}).show()),10);
    LinearLayout join=card();add(join,text("02  加入其他设备",20,ink,true),0);
    add(join,text("用系统相机扫描对方页面的二维码，或输入连接地址。下方会尝试发现同一局域网中的中转站。",14,muted,false),10);
    add(join,button("输入连接地址",false,this::joinDialog),14);
    add(join,button("重新发现附近中转站",false,this::discover),10);
    add(join,button("我的可信设备",false,this::trustedDevices),10);
    add(join,button("后台保存 / 最近保存",false,()->startActivity(new Intent(this,ReceiveQueueActivity.class))),10);
    add(join,button("后台传输队列",false,()->startActivity(new Intent(this,TransferQueueActivity.class))),10);
    add(join,button("远程连接",false,()->startActivity(new Intent(this,RemoteActivity.class))),10);
    discovered=new LinearLayout(this);discovered.setOrientation(1);add(join,discovered,8);
    LinearLayout bluetooth=card();add(bluetooth,text("03  纯蓝牙直传",20,ink,true),0);
    add(bluetooth,text("没有 Wi-Fi 或电脑时，两台安卓设备打开蓝牙直传。先在系统设置中配对，再选择发送或接收。",14,muted,false),10);
    add(bluetooth,button("打开蓝牙直传",true,()->startActivity(new Intent(this,BluetoothActivity.class))),14);
    add(bluetooth,button("系统蓝牙设置",false,()->startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS))),10);
    LinearLayout help=card();add(help,text("没有路由器，也能使用",18,ink,true),0);
    add(help,text("在一台安卓设备开启个人热点，另一台连接它，再创建中转站。局域网传输本身不使用移动数据；热点的开启要求因设备而异。\n\n局域网使用 TLS 加密；首次连接需对照主机设备页完整指纹。设备地址变化时会先核验已保存身份，再恢复连接。后台发送请使用系统分享或页面中的后台发送入口，普通网页上传仍需保持前台。不要清除应用数据或卸载应用，否则中转站文件和待发送缓存会被删除。",14,muted,false),10);
    add(help,button("打开网络设置",false,()->startActivity(new Intent(Settings.ACTION_WIRELESS_SETTINGS))),14);
    add(root,text("文件保存在你的设备上",12,muted,false),22);
  }
  private void update(){
    if(RelayService.server!=null){status.setText(RelayService.server.isSharingPaused()?"● 对外共享已暂停 · 本机仍可管理":"● 中转站运行中");launch.setEnabled(true);launch.setText("打开我的中转站");addresses.setText(String.join("\n",localUrls()));if(openWhenReady){openWhenReady=false;openHost();}}
    else{launch.setText("创建中转站并打开");addresses.setText("");if(RelayService.failure!=null){status.setText(RelayService.failure);openWhenReady=false;}else if(!openWhenReady)status.setText("尚未启动");launch.setEnabled(!openWhenReady);}
  }
  private void openHost(){RelayHttpServer s=RelayService.server;if(s!=null)openUrl("http://127.0.0.1:"+s.getLocalPort()+"/#host="+s.getHostToken());}
  private void sharingDialog(){RelayHttpServer server=RelayService.server;if(server==null){Toast.makeText(this,"请先创建本机文件池",Toast.LENGTH_LONG).show();return;}boolean pause=!server.isSharingPaused();new AlertDialog.Builder(this).setTitle(pause?"暂停对外共享？":"恢复局域网共享？").setMessage(pause?"中断其他设备在途传输并拒绝新访问；本机管理和已保存文件保留。锁定界面不等于暂停共享。":"允许已配对设备重新通过局域网连接。远程共享仍需单独开启。").setNegativeButton("取消",null).setPositiveButton(pause?"暂停共享":"恢复共享",(d,w)->{new Thread(()->{try{server.setSharingPaused(pause);runOnUiThread(()->{Toast.makeText(this,pause?"共享已暂停":"局域网共享已恢复",Toast.LENGTH_LONG).show();update();});}catch(Exception e){runOnUiThread(()->Toast.makeText(this,"操作未完成，请重试",Toast.LENGTH_LONG).show());}},"relay-sharing-state").start();}).show();}
  private void openUrl(String value){startActivity(new Intent(this,BrowserActivity.class).putExtra("url",value));}
  private void joinDialog(){EditText field=new EditText(this);field.setSingleLine(true);field.setInputType(17);field.setHint("https://192.168.1.10:8765");field.setText(getPreferences(0).getString("join",""));LinearLayout box=new LinearLayout(this);box.setPadding(dp(22),dp(10),dp(22),0);box.addView(field,new LinearLayout.LayoutParams(-1,-2));AlertDialog d=new AlertDialog.Builder(this).setTitle("加入中转站").setView(box).setNegativeButton("取消",null).setPositiveButton("打开",null).create();d.setOnShowListener(v->d.getButton(-1).setOnClickListener(w->{try{String url=ShareConnectionStore.origin(field.getText().toString().trim());if(!url.startsWith("https://"))throw new Exception();getPreferences(0).edit().putString("join",url).apply();d.dismiss();openUrl(url);}catch(Exception error){field.setError("请输入有效的 HTTPS 局域网地址");}}));d.show();}
  private void trustedDevices(){ShareConnectionStore store=new ShareConnectionStore(this);ArrayList<ShareConnectionStore.Entry> entries=store.list();ShareConnectionStore.Entry local=ShareConnectionStore.local();if(local!=null)entries.removeIf(e->e.serverId.equals(local.serverId));if(entries.isEmpty()){new AlertDialog.Builder(this).setTitle("我的可信设备").setMessage("成功核对指纹并配对后，设备会保存在这里。旧版本 HTTP 连接需要重新安全配对。").setPositiveButton("知道了",null).show();return;}String[] labels=new String[entries.size()];for(int i=0;i<labels.length;i++)labels[i]=entries.get(i).toString();new AlertDialog.Builder(this).setTitle("我的可信设备").setItems(labels,(d,index)->{ShareConnectionStore.Entry e=entries.get(index);new AlertDialog.Builder(this).setTitle(e.label).setMessage(e.origin+"\n\n已保存指纹：\n"+e.fingerprint.replaceAll("(.{8})(?!$)","$1 ")).setPositiveButton("验证并连接",(a,b)->openUrl(e.origin)).setNeutralButton("取消",null).setNegativeButton("移除信任",(a,b)->new AlertDialog.Builder(this).setTitle("移除这台设备的信任？").setMessage("会删除本机保存的连接凭据，相关后台任务将停止。再次连接必须核对主机指纹并重新配对。").setNegativeButton("取消",null).setPositiveButton("移除",(x,y)->{try{RemoteManager.remove(this,e.serverId);android.webkit.WebStorage.getInstance().deleteOrigin(e.origin);for(int qi=0;qi<TransferQueueStore.get(this).snapshot().length();qi++){org.json.JSONObject job=TransferQueueStore.get(this).snapshot().getJSONObject(qi);if(e.serverId.equals(job.optString("serverId"))&&!TransferQueueStore.terminal(job.optString("status")))UploadQueueService.control(this,UploadQueueService.CANCEL,job.getString("id"));}Toast.makeText(this,"已移除，重新连接时请核对完整指纹",Toast.LENGTH_LONG).show();}catch(Exception error){Toast.makeText(this,"移除失败，请重试",Toast.LENGTH_LONG).show();}}).show()).show();}).show();}
  static ArrayList<String> localUrls(){ArrayList<String> urls=new ArrayList<>();try{Enumeration<NetworkInterface> it=NetworkInterface.getNetworkInterfaces();while(it.hasMoreElements()){NetworkInterface n=it.nextElement();if(!n.isUp()||n.isLoopback())continue;Enumeration<InetAddress> addresses=n.getInetAddresses();while(addresses.hasMoreElements()){InetAddress a=addresses.nextElement();if(a instanceof Inet4Address&&!a.isLoopbackAddress()&&!a.isLinkLocalAddress())urls.add("https://"+a.getHostAddress()+":"+RelayService.PORT);}}}catch(Exception ignored){}return urls;}
  private void discover(){
    stopDiscovery();found.clear();serviceViews.clear();serviceUrls.clear();if(discovered==null||!active)return;discovered.removeAllViews();discoveryMessage=text("正在寻找…也可以扫码或输入地址。",12,muted,false);add(discovered,discoveryMessage,4);final int generation=discoveryGeneration;
    try{WifiManager wm=(WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);if(wm!=null){multicast=wm.createMulticastLock("RelayDrop browser");multicast.setReferenceCounted(false);multicast.acquire();}
      nsd=(NsdManager)getSystemService(NSD_SERVICE);discovery=new NsdManager.DiscoveryListener(){
        public void onDiscoveryStarted(String t){}public void onDiscoveryStopped(String t){}public void onStartDiscoveryFailed(String t,int e){runOnUiThread(()->{if(generation!=discoveryGeneration||!active)return;discoveryMessage.setText("附近发现暂不可用，请扫码或输入连接地址。");stopDiscovery();});}public void onStopDiscoveryFailed(String t,int e){}
        public void onServiceLost(NsdServiceInfo info){runOnUiThread(()->{if(generation!=discoveryGeneration||!active)return;String name=info.getServiceName(),url=serviceUrls.remove(name);View view=serviceViews.remove(name);if(view!=null)discovered.removeView(view);if(url!=null)found.remove(url);});}
        public void onServiceFound(NsdServiceInfo info){if(!info.getServiceName().startsWith("RelayDrop"))return;runOnUiThread(()->{if(generation!=discoveryGeneration||!active)return;resolveQueue.add(info);resolveNext();});}
      };nsd.discoverServices("_relaydrop._tcp.",NsdManager.PROTOCOL_DNS_SD,discovery);
    }catch(Exception ignored){if(discoveryMessage!=null)discoveryMessage.setText("附近发现暂不可用，请扫码或输入连接地址。");stopDiscovery();}
  }
  private void resolveNext(){
    if(!active||resolving||resolveQueue.isEmpty()||nsd==null)return;
    final NsdServiceInfo next=resolveQueue.remove();final int generation=discoveryGeneration;resolving=true;
    try{nsd.resolveService(next,new NsdManager.ResolveListener(){
      public void onResolveFailed(NsdServiceInfo info,int error){runOnUiThread(()->{resolving=false;if(active)resolveNext();});}
      public void onServiceResolved(NsdServiceInfo info){runOnUiThread(()->{resolving=false;if(generation==discoveryGeneration&&active&&!isDestroyed()&&info.getHost()!=null){String ip=info.getHost().getHostAddress();byte[] tls=info.getAttributes().get("tls");if(ip!=null&&!ip.contains(":")&&tls!=null&&"1".equals(new String(tls,java.nio.charset.StandardCharsets.UTF_8))){String url="https://"+ip+":"+info.getPort();if(found.add(url)){discoveryMessage.setText("发现安全中转站，连接前将核验身份。");Button entry=button(info.getServiceName()+"\n"+url,false,()->openUrl(url));serviceUrls.put(info.getServiceName(),url);serviceViews.put(info.getServiceName(),entry);add(discovered,entry,10);}}}if(active)resolveNext();});}
    });}catch(Exception error){resolving=false;handler.post(this::resolveNext);}
  }
  private void stopDiscovery(){discoveryGeneration++;resolveQueue.clear();try{if(nsd!=null&&discovery!=null)nsd.stopServiceDiscovery(discovery);}catch(Exception ignored){}discovery=null;try{if(multicast!=null&&multicast.isHeld())multicast.release();}catch(Exception ignored){}multicast=null;}
  @Override protected void onStart(){super.onStart();active=true;handler.removeCallbacks(refresh);handler.post(refresh);discover();try{org.json.JSONArray saves=ReceiveQueueStore.get(this).snapshot();for(int i=0;i<saves.length();i++){String s=saves.getJSONObject(i).optString("status");if("queued".equals(s)||"waiting".equals(s)){ReceiveQueueService.control(this,ReceiveQueueService.WAKE,null);break;}}}catch(Exception ignored){}try{org.json.JSONArray jobs=TransferQueueStore.get(this).snapshot();for(int i=0;i<jobs.length();i++){String s=jobs.getJSONObject(i).optString("status");if("queued".equals(s)||"waiting".equals(s)||"importing".equals(s)){UploadQueueService.control(this,UploadQueueService.WAKE,null);break;}}}catch(Exception ignored){}}
  @Override protected void onStop(){active=false;handler.removeCallbacks(refresh);stopDiscovery();super.onStop();}
  @Override protected void onDestroy(){handler.removeCallbacks(refresh);stopDiscovery();super.onDestroy();}
}
