package app.relaydrop;

import android.content.Context;
import android.net.nsd.*;
import android.net.wifi.WifiManager;
import java.net.Inet4Address;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Advertisements are only address candidates; credentials are never used until actual TLS pin checks pass. */
final class TrustedDiscovery {
  static ShareConnectionStore.Entry verifyOrReconnect(Context context,ShareConnectionStore.Entry saved)throws Exception{
    ShareConnectionStore.Entry local=ShareConnectionStore.local();if(local!=null&&local.serverId.equals(saved.serverId)&&local.fingerprint.equals(saved.fingerprint))return local;
    long epoch=RemoteManager.epoch();boolean savedRemote=new RemoteConnections(context).atOrigin(saved.origin)!=null;if(!savedRemote){try{TlsIdentity.Peer direct=TlsIdentity.probe(saved.origin,saved.fingerprint,saved.serverId);return RemoteManager.relocate(context,saved,direct,epoch,false);}catch(Exception ignored){}}String remote=RemoteManager.ensure(context,saved.serverId,saved.fingerprint);if(remote!=null){TlsIdentity.Peer peer=TlsIdentity.probe(remote,saved.fingerprint,saved.serverId);return RemoteManager.relocate(context,saved,peer,epoch,remote!=null);}
    Exception first;try{TlsIdentity.Peer peer=TlsIdentity.probe(saved.origin,saved.fingerprint,saved.serverId);return RemoteManager.relocate(context,saved,peer,epoch,remote!=null);}catch(Exception e){first=e;}
    final NsdManager manager=(NsdManager)context.getSystemService(Context.NSD_SERVICE);if(manager==null)throw first;final ArrayList<NsdServiceInfo> candidates=new ArrayList<>();final ArrayList<String> addresses=new ArrayList<>();final CountDownLatch scan=new CountDownLatch(1);WifiManager.MulticastLock multicast=null;
    NsdManager.DiscoveryListener listener=new NsdManager.DiscoveryListener(){public void onDiscoveryStarted(String t){}public void onDiscoveryStopped(String t){scan.countDown();}public void onStartDiscoveryFailed(String t,int e){scan.countDown();}public void onStopDiscoveryFailed(String t,int e){}public void onServiceLost(NsdServiceInfo s){}public void onServiceFound(NsdServiceInfo s){if(s.getServiceName().startsWith("RelayDrop"))synchronized(candidates){if(candidates.size()<32)candidates.add(s);}}};
    try{WifiManager wifi=(WifiManager)context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);if(wifi!=null){multicast=wifi.createMulticastLock("RelayDrop trusted reconnect");multicast.setReferenceCounted(false);multicast.acquire();}manager.discoverServices("_relaydrop._tcp.",NsdManager.PROTOCOL_DNS_SD,listener);scan.await(2500,TimeUnit.MILLISECONDS);ArrayList<NsdServiceInfo> snapshot;synchronized(candidates){snapshot=new ArrayList<>(candidates);}for(NsdServiceInfo candidate:snapshot){CountDownLatch resolved=new CountDownLatch(1);manager.resolveService(candidate,new NsdManager.ResolveListener(){public void onResolveFailed(NsdServiceInfo s,int e){resolved.countDown();}public void onServiceResolved(NsdServiceInfo s){try{Map<String,byte[]> a=s.getAttributes();String id=text(a.get("id")),fp=text(a.get("fp"));if(saved.serverId.equals(id)&&saved.fingerprint.equals(fp)&&"1".equals(text(a.get("tls")))&&s.getHost() instanceof Inet4Address&&s.getPort()>0&&s.getPort()<=65535)synchronized(addresses){addresses.add("https://"+s.getHost().getHostAddress()+":"+s.getPort());}}finally{resolved.countDown();}}});resolved.await(1500,TimeUnit.MILLISECONDS);synchronized(addresses){if(!addresses.isEmpty())break;}}
    }finally{try{manager.stopServiceDiscovery(listener);}catch(Exception ignored){}if(multicast!=null&&multicast.isHeld())multicast.release();}
    ArrayList<String> found;synchronized(addresses){found=new ArrayList<>(addresses);}for(String address:found)try{TlsIdentity.Peer peer=TlsIdentity.probe(address,saved.fingerprint,saved.serverId);return RemoteManager.relocate(context,saved,peer,epoch,remote!=null);}catch(Exception ignored){}throw first;
  }
  private static String text(byte[] bytes){return bytes==null?"":new String(bytes,StandardCharsets.UTF_8);}
}
