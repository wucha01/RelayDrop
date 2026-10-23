package app.relaydrop;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.*;
import java.io.IOException;
import java.util.*;

/** Verified directory snapshots and small identity-bound recent lists for the native share sheet. */
final class ShareDirectorySupport {
  static final class Folder {
    final String id,path;
    Folder(String id,String path){this.id=id;this.path=path;}
    @Override public String toString(){return "共享文件池 /"+(path.isEmpty()?"":" "+path);}
  }
  static final class Snapshot {
    final Map<String,JSONObject> nodes=new HashMap<>();
    final Map<String,Folder> folders=new HashMap<>();
    final ArrayList<Folder> ordered=new ArrayList<>();
    Snapshot(JSONObject state)throws Exception {
      JSONArray input=state.optJSONArray("folders");
      if(input==null)throw new IOException("此文件池尚不支持共享目录，请更新接收端。");
      if(input.length()>SharedFolders.MAX_FOLDERS)throw new IOException("共享目录清单超过限制。");
      Set<String> siblings=new HashSet<>();
      for(int i=0;i<input.length();i++){
        JSONObject f=input.getJSONObject(i);String id=SharedFolders.nullable(f,"id"),parent=SharedFolders.nullable(f,"parentId"),name=f.getString("name");
        if(id==null||nodes.put(id,f)!=null||!SafTreeFiles.segment(name).equals(name)||!siblings.add((parent==null?"":parent)+"/"+name.toLowerCase(Locale.ROOT)))throw new IOException("共享目录清单无效。");
      }
      folders.put("",new Folder(null,""));
      for(String id:nodes.keySet())resolve(id,new HashSet<>());
      ordered.addAll(folders.values());ordered.sort((a,b)->{if(a.id==null)return b.id==null?0:-1;if(b.id==null)return 1;int c=a.path.compareToIgnoreCase(b.path);return c==0?a.path.compareTo(b.path):c;});
    }
    private Folder resolve(String id,Set<String> seen)throws Exception {
      Folder existing=folders.get(id);if(existing!=null)return existing;
      if(!seen.add(id)||seen.size()>32)throw new IOException("共享目录层级无效。");JSONObject node=nodes.get(id);if(node==null)throw new IOException("共享目录父级不存在。");
      String parent=SharedFolders.nullable(node,"parentId"),prefix=parent==null?"":resolve(parent,seen).path;String path=(prefix.isEmpty()?"":prefix+"/")+node.getString("name");
      // Cached ancestors can make recursion shallow; count the resolved path as well.
      if(path.length()>1024||path.split("/",-1).length>32)throw new IOException("共享目录路径超过限制。");
      Folder folder=new Folder(id,path);folders.put(id,folder);seen.remove(id);return folder;
    }
    boolean has(String id){return folders.containsKey(id==null?"":id);}
    Folder get(String id)throws IOException {Folder f=folders.get(id==null?"":id);if(f==null)throw new IOException("原目录已删除，请重新选择保存目录。");return f;}
  }
  static void verifyIdentity(JSONObject state,ShareConnectionStore.Entry entry)throws Exception {
    JSONObject security=state.optJSONObject("security");
    if(security==null||!entry.serverId.equals(security.optString("serverId"))||!entry.fingerprint.equals(security.optString("certificateFingerprint")))throw new javax.net.ssl.SSLPeerUnverifiedException("文件池身份发生变化，请重新核对设备。");
  }
  static void validateDestination(JSONObject state,Snapshot snapshot,String target,String folder)throws Exception {
    if(target==null){snapshot.get(folder);return;}
    if(folder!=null)throw new IOException("定向发送不能放入共享目录。");
    JSONObject device=state.optJSONObject("device");String self=device==null?"":device.optString("id");JSONArray devices=state.optJSONArray("devices");
    if(devices!=null)for(int i=0;i<devices.length();i++){JSONObject d=devices.optJSONObject(i);if(d!=null&&target.equals(d.optString("id"))&&!target.equals(self)&&!d.optBoolean("revoked"))return;}
    throw new IOException("接收设备已断开或被移除，请重新连接并选择接收范围。");
  }
  private static String key(ShareConnectionStore.Entry entry){return entry.serverId+"|"+entry.fingerprint;}
  private static final Object LOCK=new Object();
  private final SharedPreferences preferences;
  ShareDirectorySupport(Context context){preferences=context.getSharedPreferences("share-directory-recents",Context.MODE_PRIVATE);}
  ArrayList<String> recent(ShareConnectionStore.Entry entry,Snapshot snapshot){synchronized(LOCK){ArrayList<String> result=new ArrayList<>();try{JSONArray all=new JSONArray(preferences.getString("pools","[]"));for(int i=0;i<all.length();i++){JSONObject pool=all.getJSONObject(i);if(!key(entry).equals(pool.optString("identity")))continue;JSONArray ids=pool.getJSONArray("folders");for(int j=0;j<ids.length()&&result.size()<6;j++){String id=ids.isNull(j)?null:ids.getString(j);if(snapshot.has(id)&&!result.contains(id))result.add(id);}break;}}catch(Exception ignored){}return result;}}
  void remember(ShareConnectionStore.Entry entry,Snapshot snapshot,String folder)throws Exception {snapshot.get(folder);synchronized(LOCK){JSONArray pools=new JSONArray(),ids=new JSONArray();ids.put(folder==null?JSONObject.NULL:folder);for(String previous:recent(entry,snapshot))if(!Objects.equals(folder,previous)&&ids.length()<6)ids.put(previous==null?JSONObject.NULL:previous);pools.put(new JSONObject().put("identity",key(entry)).put("folders",ids));try{JSONArray old=new JSONArray(preferences.getString("pools","[]"));for(int i=0;i<old.length()&&pools.length()<20;i++){JSONObject item=old.getJSONObject(i);if(!key(entry).equals(item.optString("identity")))pools.put(item);}}catch(Exception ignored){}if(!preferences.edit().putString("pools",pools.toString()).commit())throw new IOException("无法记住最近目录，文件仍可正常发送。");}}
}
