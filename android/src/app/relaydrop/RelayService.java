package app.relaydrop;

import android.app.*;
import android.content.*;
import android.net.nsd.*;
import android.net.wifi.WifiManager;
import android.os.*;

public class RelayService extends Service {
  public static volatile RelayHttpServer server;
  public static volatile String failure;
  private PowerManager.WakeLock wake;
  private WifiManager.MulticastLock multicast;
  private NsdManager nsd;
  private NsdManager.RegistrationListener registration;
  private volatile boolean destroyed=false;
  private RelayHttpServer ownedServer;
  private static volatile RelayService instance;
  static void sharingChanged(RelayHttpServer source,boolean paused){RelayService service=instance;if(service==null||service.ownedServer!=source)return;if(source.isSharingPaused()){try{if(service.nsd!=null&&service.registration!=null)service.nsd.unregisterService(service.registration);}catch(Exception ignored){}service.registration=null;}else if(service.registration==null)service.register();}
  public static final int PORT=8765;
  @Override public void onCreate(){
    super.onCreate();
    instance=this;
    NotificationManager nm=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
    nm.createNotificationChannel(new NotificationChannel("relay", "中转站运行状态", NotificationManager.IMPORTANCE_LOW));
    Intent open=new Intent(this,MainActivity.class);
    PendingIntent pi=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
    Intent stop=new Intent(this,RelayService.class).setAction("STOP");
    PendingIntent stopPi=PendingIntent.getService(this,1,stop,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
    Notification notice=new Notification.Builder(this,"relay").setContentTitle("RelayDrop 中转站运行中")
      .setContentText("手机和平板可在同一 Wi-Fi / 热点中连接；点击打开管理页面")
      .setSmallIcon(app.relaydrop.R.drawable.ic_relay).setContentIntent(pi).setOngoing(true)
      .addAction(new Notification.Action.Builder(null,"停止中转站",stopPi).build()).build();
    failure=null;
    try{startForeground(19,notice);}catch(RuntimeException error){failure="系统暂不允许启动前台中转服务，请回到应用前台重试。";stopSelf();return;}
    new Thread(()->{
      RelayHttpServer created=null;
      try{
        if(destroyed)return;
        created=new RelayHttpServer(getApplicationContext(),PORT);
        created.enableTls(new TlsIdentity(getApplicationContext()));
        created.start(120000,false);
        created.startLocalUi();
        synchronized(this){if(destroyed){created.stop();return;}ownedServer=created;server=created;
        try{PowerManager pm=(PowerManager)getSystemService(POWER_SERVICE);if(pm!=null){wake=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"RelayDrop:server");wake.acquire(6*60*60*1000L);}}catch(RuntimeException ignored){}
        try{WifiManager wm=(WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);
        if(wm!=null){multicast=wm.createMulticastLock("RelayDrop discovery");multicast.setReferenceCounted(false);multicast.acquire();}}catch(RuntimeException ignored){}
        if(!created.isSharingPaused())register();}
      }catch(Exception e){if(created!=null)created.stop();synchronized(this){if(!destroyed){failure="中转站未能启动："+(e.getMessage()==null?"请检查端口和存储空间":e.getMessage());stopSelf();}}}
    },"relay-start").start();
  }
  private void register(){
    try{
      nsd=(NsdManager)getSystemService(NSD_SERVICE);
      NsdServiceInfo info=new NsdServiceInfo();info.setServiceName("RelayDrop-"+Build.MODEL.replace(' ','-'));
      info.setServiceType("_relaydrop._tcp.");info.setPort(PORT);info.setAttribute("version","2");info.setAttribute("tls","1");info.setAttribute("id",ownedServer.identity().serverId);info.setAttribute("fp",ownedServer.identity().fingerprint);
      registration=new NsdManager.RegistrationListener(){public void onRegistrationFailed(NsdServiceInfo i,int e){}public void onUnregistrationFailed(NsdServiceInfo i,int e){}public void onServiceRegistered(NsdServiceInfo i){if(destroyed||ownedServer!=null&&ownedServer.isSharingPaused()){try{nsd.unregisterService(this);}catch(Exception ignored){}}}public void onServiceUnregistered(NsdServiceInfo i){}};
      nsd.registerService(info,NsdManager.PROTOCOL_DNS_SD,registration);
    }catch(Exception ignored){}
  }
  @Override public int onStartCommand(Intent intent,int flags,int id){if(intent!=null&&"STOP".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}return START_NOT_STICKY;}
  @Override public IBinder onBind(Intent intent){return null;}
  @Override public void onDestroy(){
    if(instance==this)instance=null;
    RemoteManager.stopHost();
    RelayHttpServer current; synchronized(this){destroyed=true;current=ownedServer;ownedServer=null;if(server==current)server=null;}if(current!=null)current.stop();
    try{if(nsd!=null&&registration!=null)nsd.unregisterService(registration);}catch(Exception ignored){}
    try{if(multicast!=null&&multicast.isHeld())multicast.release();}catch(Exception ignored){}try{if(wake!=null&&wake.isHeld())wake.release();}catch(Exception ignored){}
    super.onDestroy();
  }
}
