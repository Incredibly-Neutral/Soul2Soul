import { catFile } from '../libs/ipfs.factory';
import { evmRead } from '../libs/evm';

import {
  S2SBody,
  S2SPublicationConfig,
  S2SRipple,
  S2STemplateConfig,
} from '@s2s/soul2soul-shared/lit-actions';
import { Abi_S2SRecordsModule } from '../../../contracts/generated/abis/S2SRecordsModule.ts';

export const getConfig = async (
  configCid: string | undefined,
  configModule: string,
  rpcs?: string[],
  gateway?: string,
) => {
  let _configCid: string;
  try {
    _configCid =
      typeof configCid !== 'undefined'
        ? configCid
        : await evmRead('L2', configModule, Abi_S2SRecordsModule, 'getRecord', ['config'], rpcs);
  } catch (e) {
    throw new Error(
      `config: failed to read config record from module: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const config = await catFile(gateway!, _configCid);
    return JSON.parse(config);
  } catch (e) {
    throw new Error(
      `config: failed to cat/parse config CID ${_configCid}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export const getTaskConfig = (config: S2SPublicationConfig, body: S2SBody) => {
  const templateConfig: S2STemplateConfig | undefined = config.mapping.templateConfig.find(
    (m: any) => m.reference === body.postType,
  );

  const rippleConfigs: S2SRipple[] = config.mapping.ripples.filter((r: any) =>
    r.origins.includes(body.postType),
  );

  return {
    templateConfig,
    rippleConfigs,
  };
};