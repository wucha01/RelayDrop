package app.relaydrop;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Bounded native HTTP uploader; no WebView bridge, redirects or whole-file buffers. */
final class ShareTransport {
  interface Listener { void progress(String message,long current,long total); }
  interface Started {void accept(String id)throws Exception;}
  static final class ApiFailure extends IOException{final int status;final String code;ApiFailure(int status,String code,String message){super(message);this.status=status;this.code=code;}}
  private volatile boolean cancelled;
  private volatile HttpURLConnection active;
  final String origin,token,fingerprint;
  ShareTransport(String origin,String token)throws Exception{this(origin,token,null);}
  ShareTransport(ShareConnectionStore.Entry entry)throws Exception{this(entry.origin,entry.token,entry.fingerprint);}
  ShareTransport(String origin,String token,String fingerprint)throws Exception{this.origin=ShareConnectionStore.origin(origin);this.token=token;this.fingerprint=fingerprint;if(this.origin.startsWith("https://")&&(fingerprint==null||!fingerprint.matches("[a-f0-9]{64}")))throw new javax.net.ssl.SSLPeerUnverifiedException("请先确认设备身份。");if(this.origin.startsWith("http://")&&!ShareConnectionStore.ownLoopback(this.origin))throw new javax.net.ssl.SSLPeerUnverifiedException("明文连接仅限本机中转站。");}
  void cancel(){cancelled=true;HttpURLConnection connection=active;if(connection!=null)new Thread(connection::disconnect,"share-disconnect").start();}
  void check()throws IOException{if(cancelled||Thread.currentThread().isInterrupted())throw new IOException("已取消分享。");}
  JSONObject request(String route,String method,JSONObject json)throws Exception{return request(route,method,json==null?new byte[0]:json.toString().getBytes(StandardCharsets.UTF_8),"application/json",null,null);}
  private JSONObject request(String route,String method,byte[] body,String type,String offset,String sha)throws Exception{
    check();if(!route.startsWith("/api/")||route.contains("..")||route.contains("?")||route.contains("#"))throw new IOException("请求地址无效。");
    HttpURLConnection connection=origin.startsWith("https://")?TlsIdentity.connect(origin+route,fingerprint):(HttpURLConnection)new URL(origin+route).openConnection();active=connection;
    try{connection.setConnectTimeout(15000);connection.setReadTimeout(120000);connection.setInstanceFollowRedirects(false);connection.setRequestMethod(method);connection.setRequestProperty("Accept-Encoding","identity");if(token!=null&&!token.isEmpty())connection.setRequestProperty("Authorization","Bearer "+token);
      if(!"GET".equals(method)){connection.setDoOutput(true);connection.setRequestProperty("Content-Type",type);connection.setFixedLengthStreamingMode(body.length);if(offset!=null)connection.setRequestProperty("X-Offset",offset);if(sha!=null)connection.setRequestProperty("X-Chunk-SHA256",sha);try(OutputStream out=connection.getOutputStream()){check();out.write(body);}}
      int status=connection.getResponseCode();check();InputStream stream=status>=200&&status<300?connection.getInputStream():connection.getErrorStream();ByteArrayOutputStream data=new ByteArrayOutputStream();if(stream!=null)try(InputStream in=stream){byte[] block=new byte[8192];int n;while((n=in.read(block))!=-1){check();if(data.size()+n>8*1024*1024)throw new IOException("中转站返回的数据过大。");data.write(block,0,n);}}
      JSONObject response;try{response=new JSONObject(new String(data.toByteArray(),StandardCharsets.UTF_8));}catch(Exception e){throw new IOException("中转站没有返回有效响应。");}
      if(status<200||status>=300)throw new ApiFailure(status,response.optString("code"),response.optString("error","连接未完成，请重新配对或重试。"));return response;
    }finally{active=null;connection.disconnect();}
  }
  static String hex(byte[] bytes){StringBuilder b=new StringBuilder();for(byte value:bytes)b.append(String.format(java.util.Locale.US,"%02x",value&255));return b.toString();}
  JSONObject upload(File source,String name,String sha,String target,Listener listener)throws Exception{
    return upload(source,name,sha,target,null,listener,id->{});
  }
  JSONObject upload(File source,String name,String sha,String target,String priorId,Listener listener,Started started)throws Exception{
    return upload(source,name,sha,target,null,priorId,listener,started);
  }
  JSONObject upload(File source,String name,String sha,String target,String folderId,String priorId,Listener listener,Started started)throws Exception{
    check();long size=source.length();JSONObject begin=null;if(priorId!=null&&!priorId.isEmpty()){if(!priorId.matches("[a-fA-F0-9-]{36}"))throw new IOException("保存的传输任务无效。");try{begin=request("/api/transfers/"+priorId,"GET",null);}catch(ApiFailure error){if(error.status!=404)throw error;}}
    if(begin==null)begin=request("/api/transfers","POST",new JSONObject().put("name",name).put("size",size).put("lastModified",0).put("fingerprint",sha).put("targetId",target==null?JSONObject.NULL:target).put("folderId",folderId==null?JSONObject.NULL:folderId));
    String id=begin.getString("id");if(!id.matches("[a-fA-F0-9-]{36}"))throw new IOException("中转站返回无效传输任务。");long offset=begin.getLong("offset");int chunk=begin.optInt("chunkSize",1048576);if(offset<0||offset>size||chunk<1||chunk>1048576)throw new IOException("中转站返回无效传输位置。");
    if(begin.optLong("size",size)!=size||!name.equals(begin.optString("name",name))||!sha.equalsIgnoreCase(begin.optString("fingerprint",sha))||!java.util.Objects.equals(target,begin.isNull("targetId")?null:begin.optString("targetId"))||!java.util.Objects.equals(folderId,begin.isNull("folderId")?null:begin.optString("folderId")))throw new IOException("恢复任务与当前原件或接收位置不一致。");started.accept(id);
    try(RandomAccessFile input=new RandomAccessFile(source,"r")){input.seek(offset);while(offset<size){check();int length=(int)Math.min(chunk,size-offset);byte[] bytes=new byte[length];input.readFully(bytes);String digest=hex(MessageDigest.getInstance("SHA-256").digest(bytes));JSONObject next=request("/api/transfers/"+id,"PUT",bytes,"application/octet-stream",Long.toString(offset),digest);long confirmed=next.getLong("offset");if(confirmed!=offset+length)throw new IOException("分块确认位置不一致，请重新发送。");offset=confirmed;listener.progress("正在发送："+name,offset,size);}}
    check();listener.progress("正在核对中转站文件："+name,size,size);JSONObject completed=request("/api/transfers/"+id+"/complete","POST",new JSONObject());if(!sha.equalsIgnoreCase(completed.optString("sha256"))||completed.optLong("size",-1)!=size)throw new IOException("中转站完整文件校验不一致，不能确认发送成功。");return completed;
  }
}
