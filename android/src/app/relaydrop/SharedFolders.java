package app.relaydrop;

import org.json.*;
import java.io.IOException;
import java.util.*;

/** Shared logical paths never become storage paths; originals retain UUID names. */
final class SharedFolders {
  static final int MAX_FOLDERS=5000;
  static String nullable(JSONObject value,String key)throws IOException {Object v=value.opt(key);if(v==null||v==JSONObject.NULL)return null;if(!(v instanceof String)||!((String)v).matches("[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}"))throw new IOException("目录编号无效。");return (String)v;}
  static JSONArray all(JSONObject state)throws JSONException {JSONArray folders=state.optJSONArray("folders");if(folders==null){folders=new JSONArray();state.put("folders",folders);}return folders;}
  static JSONObject find(JSONObject state,String id)throws JSONException,IOException {if(id==null)return null;JSONArray folders=all(state);for(int i=0;i<folders.length();i++){JSONObject f=folders.getJSONObject(i);if(id.equals(f.optString("id")))return f;}throw new IOException("共享目录不存在。");}
  static List<String> path(JSONObject state,String id)throws Exception {ArrayList<String> parts=new ArrayList<>();Set<String> seen=new HashSet<>();while(id!=null){if(!seen.add(id)||parts.size()>=32)throw new IOException("目录包含循环或层级过深。");JSONObject f=find(state,id);parts.add(f.getString("name"));id=nullable(f,"parentId");}Collections.reverse(parts);if(String.join("/",parts).length()>1024)throw new IOException("目录路径超过限制。");return parts;}
  static JSONObject sibling(JSONObject state,String parent,String name,String exclude)throws Exception {JSONArray folders=all(state);for(int i=0;i<folders.length();i++){JSONObject f=folders.getJSONObject(i);if(!Objects.equals(exclude,f.optString("id"))&&Objects.equals(parent,nullable(f,"parentId"))&&name.toLowerCase(Locale.ROOT).equals(f.optString("name").toLowerCase(Locale.ROOT)))return f;}return null;}
  static JSONObject ensure(JSONObject state,String parent,JSONArray path,String owner,String created)throws Exception {
    if(path==null||path.length()==0||path.length()>32)throw new IOException("请选择 1–32 层目录。");List<String> prefix=path(state,parent);JSONArray folders=all(state),resolved=new JSONArray();String current=parent;
    // Prevalidate all names before making any state mutation.
    List<String> names=new ArrayList<>();for(int i=0;i<path.length();i++){if(!(path.opt(i) instanceof String))throw new IOException("目录名称无效。");names.add(SafTreeFiles.segment(path.getString(i)));}
    List<String> full=new ArrayList<>(prefix);full.addAll(names);if(full.size()>32||String.join("/",full).length()>1024)throw new IOException("目录层级或路径超过限制。");
    int missing=0;String probe=parent;for(String name:names){JSONObject found=missing==0?sibling(state,probe,name,null):null;if(found==null)missing++;else probe=found.getString("id");}if(folders.length()+missing>MAX_FOLDERS)throw new IOException("共享目录最多 5,000 个。");
    for(String name:names){JSONObject f=sibling(state,current,name,null);if(f==null){f=new JSONObject().put("id",UUID.randomUUID().toString()).put("parentId",current==null?JSONObject.NULL:current).put("name",name).put("createdBy",owner).put("createdAt",created);folders.put(f);}resolved.put(new JSONObject(f.toString()));current=f.getString("id");}
    return new JSONObject().put("folderId",current).put("folders",resolved);
  }
  static void validateTree(JSONObject state)throws Exception {JSONArray folders=all(state);Set<String> ids=new HashSet<>();if(folders.length()>MAX_FOLDERS)throw new IOException("目录清单过大。");for(int i=0;i<folders.length();i++){JSONObject f=folders.getJSONObject(i);String id=nullable(f,"id");if(id==null||!ids.add(id)||!SafTreeFiles.segment(f.getString("name")).equals(f.getString("name")))throw new IOException("目录清单无效。");if(sibling(state,nullable(f,"parentId"),f.getString("name"),id)!=null)throw new IOException("共享目录重名。");path(state,id);}}
}
