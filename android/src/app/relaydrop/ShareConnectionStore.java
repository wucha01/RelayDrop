package app.relaydrop;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only private LAN origins; credentials stay in app-private, Keystore-encrypted storage. */
final class ShareConnectionStore {
  static final class Entry {
    final String origin,label,token,serverId,fingerprint,expiresAt;
    Entry(String origin,String label,String token,String serverId,String fingerprint,String expiresAt){this.origin=origin;this.label=label;this.token=token;this.serverId=serverId;this.fingerprint=fingerprint;this.expiresAt=expiresAt;}
    @Override public String toString(){return label+"\n"+origin;}
  }
  private static final String KEY="relaydrop-share-connections-v1";
  private static final Object LOCK=new Object();
  private final SharedPreferences preferences;
  ShareConnectionStore(Context context){preferences=context.getSharedPreferences("share-connections",Context.MODE_PRIVATE);}
  static String origin(String raw) throws Exception {
    if(raw==null||raw.length()>1024||raw.matches("(?s).*[\\x00-\\x20\\x7f\\\\].*"))throw new IllegalArgumentException("请输入有效的局域网地址。");
    URI uri=new URI(raw.contains("://")?raw:"https://"+raw);
    boolean tls="https".equalsIgnoreCase(uri.getScheme());String host=uri.getHost();int port=uri.getPort()==-1?(tls?443:80):uri.getPort();
    if((!tls&&!"http".equalsIgnoreCase(uri.getScheme()))||host==null||uri.getRawUserInfo()!=null||port<1||port>65535)throw new IllegalArgumentException("请输入有效的 HTTPS 中转站地址。");
    boolean local="localhost".equalsIgnoreCase(host);
    String[] parts=host.split("\\.");
    if(parts.length==4){int[] a=new int[4];for(int i=0;i<4;i++){if(!parts[i].matches("0|[1-9][0-9]{0,2}"))throw new IllegalArgumentException("请输入中转站显示的局域网 IPv4 地址。");a[i]=Integer.parseInt(parts[i]);if(a[i]>255)throw new IllegalArgumentException("局域网地址无效。");}local=a[0]==10||a[0]==127||a[0]==192&&a[1]==168||a[0]==172&&a[1]>=16&&a[1]<=31||a[0]==169&&a[1]==254;}
    if(!local)throw new IllegalArgumentException("分享仅连接本机或私人局域网 IPv4 地址。");
    if(!tls&&!"localhost".equalsIgnoreCase(host)&&!"127.0.0.1".equals(host))throw new IllegalArgumentException("局域网 HTTP 不再支持，请使用 HTTPS 地址并核对设备身份。");
    return (tls?"https://":"http://")+host.toLowerCase(java.util.Locale.US)+(port==(tls?443:80)?"":":"+port);
  }
  private static synchronized SecretKey key() throws Exception {
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
    if(store.containsAlias(KEY))return (SecretKey)store.getKey(KEY,null);
    KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());return generator.generateKey();
  }
  private static String encrypt(String value,String origin) throws Exception {Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());c.updateAAD(origin.getBytes(StandardCharsets.UTF_8));return Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);}
  private static String decrypt(String value,String origin) throws Exception {String[] pieces=value.split(":",2);if(pieces.length!=2)throw new IllegalArgumentException();Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(pieces[0],Base64.NO_WRAP)));c.updateAAD(origin.getBytes(StandardCharsets.UTF_8));return new String(c.doFinal(Base64.decode(pieces[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);}
  ArrayList<Entry> list(){synchronized(LOCK){ArrayList<Entry> result=new ArrayList<>();try{JSONArray array=new JSONArray(preferences.getString("connections","[]"));for(int i=0;i<array.length()&&i<20;i++){try{JSONObject item=array.getJSONObject(i);if(item.optInt("version")!=2)continue;String host=origin(item.getString("origin")),id=item.getString("serverId"),fp=item.getString("fingerprint");if(!id.matches("[a-f0-9-]{36}")||!fp.matches("[a-f0-9]{64}"))continue;result.add(new Entry(host,item.optString("label","中转站"),decrypt(item.getString("credential"),id+"|"+fp),id,fp,item.optString("expiresAt")));}catch(Exception ignored){}}}catch(Exception ignored){}return result;}}
  Entry findOrigin(String raw)throws Exception{String host=origin(raw);for(Entry e:list())if(e.origin.equals(host))return e;return null;}
  Entry findId(String id){for(Entry e:list())if(e.serverId.equals(id))return e;return null;}
  static Entry local(){RelayHttpServer server=RelayService.server;if(server==null||server.identity()==null)return null;TlsIdentity identity=server.identity();return new Entry("http://127.0.0.1:"+server.getLocalPort(),"本机文件池",server.getHostToken(),identity.serverId,identity.fingerprint,identity.expiresAt);}
  static boolean ownLoopback(String raw){try{Entry local=local();return local!=null&&local.origin.equals(origin(raw));}catch(Exception e){return false;}}
  void put(String raw,String label,String token)throws Exception{String host=origin(raw);Entry known=findOrigin(host);if(known==null&&ownLoopback(host))known=local();if(known==null)throw new IllegalArgumentException("请先核对并确认设备证书指纹。");putEntry(new Entry(host,label,token,known.serverId,known.fingerprint,known.expiresAt));}
  void putTrusted(TlsIdentity.Peer peer,String label,String token)throws Exception{putEntry(new Entry(peer.origin,label,token,peer.serverId,peer.fingerprint,peer.expiresAt));}
  Entry relocate(Entry previous,TlsIdentity.Peer peer)throws Exception{if(!previous.serverId.equals(peer.serverId)||!previous.fingerprint.equals(peer.fingerprint))throw new javax.net.ssl.SSLPeerUnverifiedException("设备身份不一致，不能移动连接凭据。");Entry value=new Entry(peer.origin,previous.label,previous.token,previous.serverId,previous.fingerprint,peer.expiresAt);putEntry(value);return value;}
  private void putEntry(Entry entry)throws Exception{synchronized(LOCK){if(entry.token==null||!entry.token.matches("[A-Za-z0-9_-]{16,256}"))throw new IllegalArgumentException("连接凭证无效。");JSONArray list=new JSONArray();list.put(encode(entry));for(Entry old:list())if(list.length()<20&&!old.serverId.equals(entry.serverId))list.put(encode(old));if(!preferences.edit().putString("connections",list.toString()).commit())throw new java.io.IOException("无法保存可信连接。");}}
  private JSONObject encode(Entry value)throws Exception{return new JSONObject().put("version",2).put("origin",value.origin).put("label",value.label==null?"中转站":value.label.substring(0,Math.min(80,value.label.length()))).put("serverId",value.serverId).put("fingerprint",value.fingerprint).put("expiresAt",value.expiresAt).put("credential",encrypt(value.token,value.serverId+"|"+value.fingerprint));}
  void forget(String id)throws Exception{synchronized(LOCK){JSONArray next=new JSONArray();for(Entry e:list())if(!e.serverId.equals(id))next.put(encode(e));if(!preferences.edit().putString("connections",next.toString()).commit())throw new java.io.IOException("无法更新可信设备。");}}
}
