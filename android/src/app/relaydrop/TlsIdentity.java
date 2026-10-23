package app.relaydrop;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONObject;
import javax.net.ssl.*;
import javax.security.auth.x500.X500Principal;
import java.io.*;
import java.math.BigInteger;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.*;

/** Per-device TLS identity and per-connection trust; never installs a global trust override. */
final class TlsIdentity {
  static final String PROTOCOL="relaydrop-tls-v1",KEY="relaydrop-server-tls-v3";
  final String serverId,fingerprint,expiresAt;
  final X509Certificate certificate;
  final SSLServerSocketFactory socketFactory;
  TlsIdentity(Context context)throws Exception{
    android.content.SharedPreferences prefs=context.getSharedPreferences("tls-identity",Context.MODE_PRIVATE);String id=prefs.getString("id",null);if(id==null){id=UUID.randomUUID().toString();if(!prefs.edit().putString("id",id).commit())throw new IOException("无法保存设备身份。");}serverId=id;
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(!store.containsAlias(KEY)){
      KeyPairGenerator generator=KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA,"AndroidKeyStore");Date start=new Date(System.currentTimeMillis()-86_400_000L),end=new Date(System.currentTimeMillis()+3650L*86_400_000L);
      // Conscrypt performs the already-padded TLS RSA signature through its raw private-key upcall.
      generator.initialize(new KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_SIGN|KeyProperties.PURPOSE_VERIFY|KeyProperties.PURPOSE_DECRYPT).setKeySize(2048).setDigests(KeyProperties.DIGEST_NONE,KeyProperties.DIGEST_SHA256,KeyProperties.DIGEST_SHA384,KeyProperties.DIGEST_SHA512).setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1,KeyProperties.SIGNATURE_PADDING_RSA_PSS).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1,KeyProperties.ENCRYPTION_PADDING_NONE).setCertificateSubject(new X500Principal("CN=RelayDrop "+id)).setCertificateSerialNumber(new BigInteger(120,new SecureRandom()).add(BigInteger.ONE)).setCertificateNotBefore(start).setCertificateNotAfter(end).build());generator.generateKeyPair();
    }
    certificate=(X509Certificate)store.getCertificate(KEY);certificate.checkValidity();fingerprint=fingerprint(certificate);expiresAt=certificate.getNotAfter().toInstant().toString();final PrivateKey privateKey=(PrivateKey)store.getKey(KEY,null);KeyManager manager=new X509ExtendedKeyManager(){public String[] getClientAliases(String type,java.security.Principal[] issuers){return null;}public String chooseClientAlias(String[] types,java.security.Principal[] issuers,Socket socket){return null;}public String[] getServerAliases(String type,java.security.Principal[] issuers){return "RSA".equals(type)?new String[]{KEY}:null;}public String chooseServerAlias(String type,java.security.Principal[] issuers,Socket socket){return "RSA".equals(type)?KEY:null;}public String chooseEngineServerAlias(String type,java.security.Principal[] issuers,SSLEngine engine){return "RSA".equals(type)?KEY:null;}public X509Certificate[] getCertificateChain(String alias){return KEY.equals(alias)?new X509Certificate[]{certificate}:null;}public PrivateKey getPrivateKey(String alias){return KEY.equals(alias)?privateKey:null;}};SSLContext ssl=SSLContext.getInstance("TLS");ssl.init(new KeyManager[]{manager},null,new SecureRandom());socketFactory=ssl.getServerSocketFactory();
  }
  JSONObject json()throws Exception{return new JSONObject().put("protocol",PROTOCOL).put("serverId",serverId).put("certificateFingerprint",fingerprint).put("certificateExpiresAt",expiresAt);}
  static String fingerprint(X509Certificate certificate)throws Exception{return ShareTransport.hex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()));}
  static final class Peer {
    final String origin,serverId,fingerprint,expiresAt;
    Peer(String origin,JSONObject value,String actual)throws Exception{this.origin=origin;serverId=value.getString("serverId");fingerprint=value.getString("certificateFingerprint");expiresAt=value.getString("certificateExpiresAt");if(!PROTOCOL.equals(value.optString("protocol"))||!serverId.matches("[a-f0-9-]{36}")||!fingerprint.equals(actual))throw new SSLPeerUnverifiedException("TLS 证书与设备身份不一致。");}
  }
  static HttpsURLConnection connect(String address,String expectedFingerprint)throws Exception{
    if(!address.startsWith("https://"))throw new SSLPeerUnverifiedException("局域网连接必须使用 HTTPS。");if(expectedFingerprint!=null&&!expectedFingerprint.matches("[a-f0-9]{64}"))throw new SSLPeerUnverifiedException("可信设备指纹无效。");
    TrustManager[] trust={new X509TrustManager(){public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}public void checkClientTrusted(X509Certificate[] c,String a)throws CertificateException{throw new CertificateException("Client certificate unsupported");}public void checkServerTrusted(X509Certificate[] chain,String auth)throws CertificateException{if(chain==null||chain.length==0)throw new CertificateException("Missing server certificate");chain[0].checkValidity();try{if(expectedFingerprint!=null&&!MessageDigest.isEqual(expectedFingerprint.getBytes(StandardCharsets.US_ASCII),fingerprint(chain[0]).getBytes(StandardCharsets.US_ASCII)))throw new CertificateException("设备证书已变化，已阻止连接。请在主机核对身份后重新配对。");}catch(CertificateException e){throw e;}catch(Exception e){throw new CertificateException(e);}}}};
    SSLContext context=SSLContext.getInstance("TLS");context.init(null,trust,new SecureRandom());HttpsURLConnection connection=(HttpsURLConnection)new URL(address).openConnection();connection.setSSLSocketFactory(new ModernSockets(context.getSocketFactory()));connection.setHostnameVerifier((host,session)->{try{X509Certificate leaf=(X509Certificate)session.getPeerCertificates()[0];return expectedFingerprint==null||expectedFingerprint.equals(fingerprint(leaf));}catch(Exception e){return false;}});connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(10000);connection.setReadTimeout(10000);return connection;
  }
  private static final class ModernSockets extends SSLSocketFactory {
    private final SSLSocketFactory delegate;ModernSockets(SSLSocketFactory delegate){this.delegate=delegate;}
    private Socket modern(Socket socket){if(socket instanceof SSLSocket){SSLSocket ssl=(SSLSocket)socket;ArrayList<String> enabled=new ArrayList<>();for(String p:ssl.getSupportedProtocols())if("TLSv1.2".equals(p)||"TLSv1.3".equals(p))enabled.add(p);ssl.setEnabledProtocols(enabled.toArray(new String[0]));}return socket;}
    public String[] getDefaultCipherSuites(){return delegate.getDefaultCipherSuites();}public String[] getSupportedCipherSuites(){return delegate.getSupportedCipherSuites();}
    public Socket createSocket(Socket s,String h,int p,boolean c)throws IOException{return modern(delegate.createSocket(s,h,p,c));}public Socket createSocket(String h,int p)throws IOException{return modern(delegate.createSocket(h,p));}public Socket createSocket(String h,int p,InetAddress l,int lp)throws IOException{return modern(delegate.createSocket(h,p,l,lp));}public Socket createSocket(InetAddress h,int p)throws IOException{return modern(delegate.createSocket(h,p));}public Socket createSocket(InetAddress h,int p,InetAddress l,int lp)throws IOException{return modern(delegate.createSocket(h,p,l,lp));}public Socket createSocket()throws IOException{return modern(delegate.createSocket());}
  }
  /** Unauthenticated first-contact probe. Its result must be confirmed before any credential is sent. */
  static Peer probe(String raw,String expectedFingerprint,String expectedId)throws Exception{
    String origin=ShareConnectionStore.origin(raw);if(!origin.startsWith("https://"))throw new SSLPeerUnverifiedException("请使用 HTTPS 中转站地址。");HttpsURLConnection c=connect(origin+"/api/identity",expectedFingerprint);
    try{if(c.getResponseCode()!=200)throw new IOException("对方没有提供安全设备身份。");X509Certificate leaf=(X509Certificate)c.getServerCertificates()[0];String actual=fingerprint(leaf);ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){byte[] b=new byte[1024];int n;while((n=in.read(b))!=-1){if(out.size()+n>4096)throw new IOException("设备身份响应异常。");out.write(b,0,n);}}Peer peer=new Peer(origin,new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8)),actual);if(expectedId!=null&&!expectedId.equals(peer.serverId))throw new SSLPeerUnverifiedException("设备身份编号发生变化，已阻止自动重连。");return peer;}finally{c.disconnect();}
  }
  static String[] protocols(){return Build.VERSION.SDK_INT>=29?new String[]{"TLSv1.3","TLSv1.2"}:new String[]{"TLSv1.2"};}
}
