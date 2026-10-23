package app.relaydrop;

import android.app.*;
import android.content.*;
import android.os.*;

/** Explicitly started service; nothing connects remotely until the user opts in. */
public class RemoteService extends Service {
  static final String HOST="HOST",STOP_HOST="STOP_HOST",STOP="STOP";
  private volatile boolean destroyed;
  private volatile int generation;
  @Override public void onCreate(){super.onCreate();NotificationManager nm=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);nm.createNotificationChannel(new NotificationChannel("remote","远程连接状态",NotificationManager.IMPORTANCE_LOW));PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,RemoteActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);PendingIntent stop=PendingIntent.getService(this,0,new Intent(this,RemoteService.class).setAction(STOP),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);try{startForeground(25,new Notification.Builder(this,"remote").setSmallIcon(app.relaydrop.R.drawable.ic_relay).setContentTitle("RelayDrop 远程连接已启用").setContentText("文件池设备需保持在线；点此查看连接状态").setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null,"停止远程连接",stop).build()).build());}catch(RuntimeException e){RemoteManager.hostStatus="系统拒绝前台远程服务，请回到应用重试。";stopSelf();}}
  @Override public synchronized int onStartCommand(Intent intent,int flags,int id){String action=intent==null?null:intent.getAction();if(STOP.equals(action)){stopSelf();return START_NOT_STICKY;}if(STOP_HOST.equals(action)){generation++;RemoteManager.stopHost();return START_NOT_STICKY;}if(HOST.equals(action)){final int version=++generation;RemoteManager.hostStatus="正在启动本机文件池…";new Thread(()->{try{for(int i=0;i<100&&RelayService.server==null&&!destroyed&&generation==version;i++)Thread.sleep(200);synchronized(RemoteService.this){if(!destroyed&&generation==version)RemoteManager.startHost(getApplicationContext());}}catch(Exception e){RemoteManager.hostStatus="远程共享未启动："+UploadQueueService.message(e);}},"relay-remote-service").start();}return START_NOT_STICKY;}
  @Override public IBinder onBind(Intent intent){return null;}
  @Override public synchronized void onDestroy(){destroyed=true;generation++;try{RemoteManager.enabled(this,false);}catch(Exception ignored){}RemoteManager.close();super.onDestroy();}
}
