package app.relaydrop;

import android.content.*;
import org.json.*;
import java.io.*;
import java.util.*;

/** Process-local listener ownership is separate from durable encrypted invitation storage. */
final class RemoteManager {
  private static final Map<String,RemoteTunnel> clients=new HashMap<>();
  private static RemoteTunnel host;
  private static long epoch;
  static volatile String hostStatus="未配置中继，远程共享未开启";
  static synchronized void enabled(Context context,boolean value)throws IOException{if(!context.getSharedPreferences("remote-state",Context.MODE_PRIVATE).edit().putBoolean("enabled",value).commit())throw new IOException("远程状态保存失败。");if(!value)epoch++;}
  static synchronized long epoch(){return epoch;}
  static synchronized void requireEpoch(long expected)throws IOException{if(expected!=epoch)throw new IOException("远程操作已取消，旧连接不能恢复信任。");}
  private static void requireProfile(Context context,TlsIdentity.Peer peer,long expectedEpoch)throws Exception{requireEpoch(expectedEpoch);if(!context.getSharedPreferences("remote-state",Context.MODE_PRIVATE).getBoolean("enabled",false))throw new IOException("远程连接已关闭。");JSONObject p=new RemoteConnections(context).profile(peer.serverId);if(p==null||!("https://127.0.0.1:"+p.getInt("port")).equals(peer.origin)||!p.getJSONObject("invite").getString("fingerprint").equals(peer.fingerprint))throw new IOException("远程设备信任已移除。");}
  static synchronized ShareConnectionStore.Entry relocate(Context context,ShareConnectionStore.Entry prior,TlsIdentity.Peer peer,long expectedEpoch,boolean remote)throws Exception{requireEpoch(expectedEpoch);if(remote)requireProfile(context,peer,expectedEpoch);ShareConnectionStore store=new ShareConnectionStore(context);ShareConnectionStore.Entry current=store.findId(prior.serverId);if(current==null||!current.fingerprint.equals(prior.fingerprint)||!current.token.equals(prior.token))throw new IOException("可信凭据已移除或更换，请重新确认设备。");return store.relocate(prior,peer);}
  static synchronized void verified(Context context,TlsIdentity.Peer peer,long expectedEpoch,boolean remote)throws Exception{requireEpoch(expectedEpoch);if(remote)requireProfile(context,peer,expectedEpoch);}
  static synchronized void remember(Context context,TlsIdentity.Peer peer,String label,String credential,long expectedEpoch)throws Exception{remember(context,peer,label,credential,expectedEpoch,true);}
  static synchronized void remember(Context context,TlsIdentity.Peer peer,String label,String credential,long expectedEpoch,boolean remote)throws Exception{requireEpoch(expectedEpoch);if(remote)requireProfile(context,peer,expectedEpoch);new ShareConnectionStore(context).putTrusted(peer,label,credential);}
  static synchronized String connect(Context context,JSONObject invitation)throws Exception{
    return connect(context,invitation,epoch);
  }
  static synchronized String connect(Context context,JSONObject invitation,long expectedEpoch)throws Exception{
    if(expectedEpoch!=epoch||!context.getSharedPreferences("remote-state",Context.MODE_PRIVATE).getBoolean("enabled",false))throw new IOException("远程操作已取消，请重新连接。");
    RemoteConnections store=new RemoteConnections(context);String id=invitation.getString("serverId");JSONObject old=store.profile(id);if(old!=null&&!old.getJSONObject("invite").getString("fingerprint").equals(invitation.getString("fingerprint")))throw new IOException("设备证书变化，请先移除旧远程设备并核对新身份。");
    RemoteTunnel running=clients.get(id);if(running!=null){running.close();clients.remove(id);}RemoteTunnel created=new RemoteTunnel(invitation,false);try{int port=created.startClient(old==null?0:old.getInt("port"));store.put(invitation,port);clients.put(id,created);return "https://127.0.0.1:"+port;}catch(Exception e){created.close();throw e;}
  }
  static synchronized String ensure(Context context,String id,String fingerprint)throws Exception{
    JSONObject profile=new RemoteConnections(context).profile(id);if(profile==null)return null;if(!context.getSharedPreferences("remote-state",Context.MODE_PRIVATE).getBoolean("enabled",false))throw new IOException("远程连接已关闭，请在远程连接页重新开启。");JSONObject invite=profile.getJSONObject("invite");if(!invite.getString("fingerprint").equals(fingerprint))throw new javax.net.ssl.SSLPeerUnverifiedException("远程邀请与已配对设备的指纹不一致。");RemoteTunnel tunnel=clients.get(id);if(tunnel==null){tunnel=new RemoteTunnel(invite,false);try{tunnel.startClient(profile.getInt("port"));clients.put(id,tunnel);}catch(Exception e){tunnel.close();throw new IOException("远程入口无法恢复，本地端口被占用或配置无效。",e);}}return "https://127.0.0.1:"+tunnel.port();
  }
  static synchronized void startHost(Context context)throws Exception{
    stopHost();RelayHttpServer server=RelayService.server;if(server==null)throw new IOException("请先启动本机文件池。");if(server.isSharingPaused())throw new IOException("共享已暂停，请先恢复共享。");JSONObject config=new RemoteConnections(context).host();if(config==null)throw new IOException("尚未配置中继服务器。");config.put("room",server.identity().serverId);int port=server.startRemoteTls();RemoteTunnel next=new RemoteTunnel(config,true);try{next.startHost(port);host=next;}catch(Exception e){next.close();server.stopRemoteTls();throw e;}
  }
  static synchronized void stopHost(){if(host!=null){host.close();host=null;}RelayHttpServer server=RelayService.server;if(server!=null)server.stopRemoteTls();hostStatus="远程共享已停止";}
  static synchronized String status(){return host==null?hostStatus:host.status;}
  static synchronized void rotateInvitation(Context context)throws Exception{boolean running=host!=null;stopHost();new RemoteConnections(context).rotateInvitation();if(running)startHost(context);}
  static synchronized void remove(Context context,String id)throws Exception{epoch++;JSONObject old=new RemoteConnections(context).profile(id);RemoteTunnel t=clients.remove(id);if(t!=null)t.close();new RemoteConnections(context).remove(id);new ShareConnectionStore(context).forget(id);context.sendBroadcast(new Intent("app.relaydrop.TRUST_REMOVED").setPackage(context.getPackageName()).putExtra("serverId",id));if(old!=null)android.webkit.WebStorage.getInstance().deleteOrigin("https://127.0.0.1:"+old.getInt("port"));JSONArray jobs=TransferQueueStore.get(context).snapshot();for(int i=0;i<jobs.length();i++){JSONObject job=jobs.getJSONObject(i);if(id.equals(job.optString("serverId"))&&!TransferQueueStore.terminal(job.optString("status")))UploadQueueService.control(context,UploadQueueService.CANCEL,job.getString("id"));}}
  static synchronized void close(){epoch++;stopHost();for(RemoteTunnel t:clients.values())t.close();clients.clear();}
}
