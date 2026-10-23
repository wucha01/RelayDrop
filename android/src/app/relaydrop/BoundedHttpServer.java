package app.relaydrop;
import fi.iki.elonen.NanoHTTPD;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

/** Reject excess sockets before creating worker threads; slow headers have an absolute deadline. */
class BoundedHttpServer extends NanoHTTPD {
  private static final ThreadLocal<Connection> CURRENT=new ThreadLocal<>();
  private static final class Connection {final Socket socket;final String peer;volatile long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);volatile boolean response;Connection(Socket socket){this.socket=socket;peer=socket.getInetAddress().getHostAddress();}void close(){try{socket.close();}catch(IOException ignored){}}}
  private final Map<ClientHandler,Connection> pending=new ConcurrentHashMap<>(),running=new ConcurrentHashMap<>();
  private final Object quota=new Object();private final Map<String,Integer> perIp=new HashMap<>();private final int maximum,ipMaximum;
  private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"relay-http-deadlines");t.setDaemon(true);return t;});
  private final ExecutorService workers;
  BoundedHttpServer(int port){this(null,port,32,8);}
  BoundedHttpServer(String host,int port,int maximum,int perIp){super(host,port);this.maximum=maximum;ipMaximum=perIp;workers=new ThreadPoolExecutor(0,maximum,30,TimeUnit.SECONDS,new SynchronousQueue<>(),r->{Thread t=new Thread(r,"relay-http-worker");t.setDaemon(true);return t;});setAsyncRunner(new AsyncRunner(){public void closed(ClientHandler handler){}public void closeAll(){for(ClientHandler h:new ArrayList<>(running.keySet()))h.close();}public void exec(ClientHandler handler){Connection c=pending.remove(handler);if(c==null){handler.close();return;}synchronized(quota){int used=BoundedHttpServer.this.perIp.getOrDefault(c.peer,0);if(running.size()>=BoundedHttpServer.this.maximum||used>=ipMaximum){handler.close();return;}BoundedHttpServer.this.perIp.put(c.peer,used+1);running.put(handler,c);}try{workers.execute(()->{CURRENT.set(c);try{handler.run();}finally{CURRENT.remove();running.remove(handler);synchronized(quota){int remaining=BoundedHttpServer.this.perIp.getOrDefault(c.peer,1)-1;if(remaining<=0)BoundedHttpServer.this.perIp.remove(c.peer);else BoundedHttpServer.this.perIp.put(c.peer,remaining);}c.close();}});}catch(RejectedExecutionException rejected){running.remove(handler);synchronized(quota){int left=BoundedHttpServer.this.perIp.getOrDefault(c.peer,1)-1;if(left<=0)BoundedHttpServer.this.perIp.remove(c.peer);else BoundedHttpServer.this.perIp.put(c.peer,left);}handler.close();}}});timer.scheduleAtFixedRate(()->{long now=System.nanoTime();for(Connection c:running.values())if(now>c.deadline)c.close();},1,1,TimeUnit.SECONDS);}
  @Override protected ClientHandler createClientHandler(Socket socket,InputStream stream){Connection c=new Connection(socket);InputStream bounded=new FilterInputStream(stream){private void before()throws IOException{if(c.response){c.response=false;c.deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);}if(System.nanoTime()>c.deadline)throw new SocketTimeoutException("Request deadline exceeded");}public int read()throws IOException{before();return super.read();}public int read(byte[] b,int off,int len)throws IOException{before();return in.read(b,off,len);}};ClientHandler result=new ClientHandler(bounded,socket);pending.put(result,c);return result;}
  static void beginBody(){Connection c=CURRENT.get();if(c!=null){c.response=false;c.deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);}}
  static void responseReady(){Connection c=CURRENT.get();if(c!=null){c.response=true;c.deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(120);}}
  static void streamProgress(){Connection c=CURRENT.get();if(c!=null)c.deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);}
  static int remotePort(){Connection c=CURRENT.get();return c==null?-1:c.socket.getPort();}
  static Closeable currentSocket(){Connection c=CURRENT.get();return c==null?null:c.socket;}
  static boolean cancelled(){Connection c=CURRENT.get();return c!=null&&c.socket.isClosed();}
  void disconnectClients(){asyncRunner.closeAll();}
  @Override public void stop(){super.stop();for(Connection c:pending.values())c.close();pending.clear();workers.shutdownNow();timer.shutdownNow();}
}
