export interface PKP {
  tokenId: string;
  publicKey: string;
  ethAddress: string;
}

export interface S2SProtocolInfo {
    addr: string | undefined,
    recordsModule: string,
    dataGateway: string,
    assetsGateway: string,
    lensApp: string,
    ensRecords: string,
    pkp: PKP
    litActionPrep: string,
    litActionCbor: string,
    litActionSingle: string,
    litActionRootUpdate: string
}