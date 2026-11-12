import { requireOptionalNativeModule } from 'expo-modules-core';
export interface NearbyNative {
 capabilities():Promise<{supported:boolean;permissionsGranted:boolean;bluetoothEnabled:boolean;bleScan:boolean;bleAdvertise:boolean;localPeer:boolean;backgroundBle:false}>;
 start(options:{serviceUuid:string;characteristicUuid:string;token:string;expiresAtMs:number}):Promise<void>;
 stop():Promise<void>;
 addListener(name:'onCheckpoint'|'onState',listener:(value:any)=>void):{remove():void};
}
export const tripNearbyNative=requireOptionalNativeModule<NearbyNative>('PortavaNearbyCheckpoint');
