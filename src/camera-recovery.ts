/** Serialize page-resume events: Safari may emit both pageshow and visibilitychange. */
export class CameraRecovery {
  private busy=false;
  constructor(private host:{eligible:()=>boolean;ended:()=>boolean;restart:()=>Promise<void>;reconnect:()=>Promise<void>}){}
  async resume():Promise<void>{
    if(this.busy||!this.host.eligible())return;
    this.busy=true;
    try{if(this.host.ended())await this.host.restart();else await this.host.reconnect();}
    finally{this.busy=false;}
  }
}
