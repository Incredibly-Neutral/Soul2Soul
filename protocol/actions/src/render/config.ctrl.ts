

import { catFile } from "../libs/ipfs.factory";
import { evmRead } from "../libs/evm";

import { S2SBody, S2SPublicationConfig, S2SRipple, S2STemplateConfig } from "@s2s/soul2soul-shared/lit-actions";
import { Abi_S2SRecordsModule } from '../../../contracts/generated/abis/S2SRecordsModule.ts'

export const getConfig = async (configCid: string | undefined, configModule: string) => {

      const _configCid = typeof configCid !== "undefined" 
        ? configCid 
        : await evmRead("BASE", configModule, Abi_S2SRecordsModule, "getRecord", ["config"]);
      
      let config = await catFile(_configCid);
      return JSON.parse(config); 
};


export const getTaskConfig = (config: S2SPublicationConfig, body: S2SBody) => {

  let templateConfig: S2STemplateConfig | undefined =
    config.mapping.templateConfig.find(
      (m: any) => m.reference === body.postType,
    );


  if (templateConfig == undefined) {
    templateConfig = config.mapping.templateConfig.find((m: any) => {
      return m.collections?.some(
        (collection: any) => collection.value === body.postType,
      );
    });
  }

  if (templateConfig == undefined) {
    throw new Error(`No mapping found for post_type: ${body.postType}`);
  }

  const rippleConfigs: S2SRipple[] = config.mapping.ripples.filter((r: any) =>
    r.origins.includes(body.postType),
  );

  return {
    templateConfig,
    rippleConfigs,
  };
};
