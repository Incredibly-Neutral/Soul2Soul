/// <reference path="../action_globals.ts" />

import { catFile } from "../libs/ipfs.factory";
import { evmRead } from "../libs/evm";


import { recordsModuleAbi, S2SBody, S2SPublicationConfig, S2SRipple, S2STemplateConfig, validateConfig } from "@s2s/soul2soul-shared/lit-actions";

export const getConfig = async (authorSafeAddress: string, configCid: string | undefined, configModule: string, dev: boolean) => {

    return JSON.parse(await LitActions.runOnce({
        waitForResponse: true,
        name: `config-${authorSafeAddress}`
    }, async () => { 

      const _configCid = dev &&  typeof configCid !== "undefined" 
        ? configCid 
        : await evmRead("BASE", configModule, recordsModuleAbi, "getRecord", ["config"]);
      
      console.log(_configCid)
      let config = await catFile(_configCid);
      console.log(config)
      validateConfig(JSON.parse(config));
      return config; 
    }));
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
