import ejs from 'ejs';
import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { exit } from 'node:process';

import { Injectable, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import {
    SubscriptionPageRawConfigSchema,
    TSubscriptionPageRawConfig,
    SUBPAGE_DEFAULT_CONFIG_UUID,
} from '@remnawave/subscription-page-types';

import { AxiosService } from '@common/axios';
import { TypedConfigService } from '@common/config/app-config';
import { getAssetsPath, isDevelopment } from '@common/utils';
import { decryptUuid, encryptUuid } from '@common/utils/crypt-utils';

@Injectable()
export class WebpageService implements OnApplicationBootstrap {
    private readonly logger = new Logger(WebpageService.name);
    private readonly internalJwtSecret: string;
    private readonly subpageConfigUuid: string;
    private readonly subpageConfigMap: Map<string, TSubscriptionPageRawConfig> = new Map();
    private indexTemplate: ejs.TemplateFunction;

    constructor(
        private readonly configService: TypedConfigService,
        private readonly axiosService: AxiosService,
        private readonly jwtService: JwtService,
    ) {
        this.internalJwtSecret = this.configService.getOrThrow('INTERNAL_JWT_SECRET');
        this.subpageConfigUuid = this.configService.getOrThrow('SUBPAGE_CONFIG_UUID');
    }

    public async onApplicationBootstrap(): Promise<void> {
        this.indexTemplate = ejs.compile(
            readFileSync(path.join(getAssetsPath(), 'index.html'), 'utf8'),
        );

        const subscriptionPageConfigList = await this.fetchSubscriptionPageConfigList();

        if (subscriptionPageConfigList.length === 0) {
            this.logger.error('[FATAL] Subscription page config list is empty, exiting...');

            exit(1);
        }

        this.logger.log(`Found ${subscriptionPageConfigList.length} subscription page configs.`);

        for (const config of subscriptionPageConfigList) {
            const subscriptionPageConfig =
                await this.axiosService.getSubscriptionPageConfigByUuid(config);

            if (!subscriptionPageConfig.isOk || !subscriptionPageConfig.response) {
                this.logger.error(
                    `[FATAL] Error while fetching one of subpage config: ${config}, exiting...`,
                );

                exit(1);
            }

            const parsedConfig = await SubscriptionPageRawConfigSchema.safeParseAsync(
                subscriptionPageConfig.response.config,
            );

            if (!parsedConfig.success) {
                this.logger.error(
                    `[FATAL] ${config} is not valid: ${JSON.stringify(parsedConfig.error)}`,
                );

                exit(1);
            }

            this.logger.log(`[OK] ${config}`);
            this.subpageConfigMap.set(config, parsedConfig.data);
        }

        if (this.subpageConfigMap.size === 0) {
            this.logger.error('[FAILED] At least one SubPage config must be valid!');
            exit(1);
        }

        this.logger.log('[OK] Subpage configs are loaded successfully.');
    }

    public async getSubscriptionPageConfig(
        encryptedSubpageConfigUuid: string,
    ): Promise<object | void> {
        const decryptedSubpageConfigUuid = decryptUuid(
            encryptedSubpageConfigUuid,
            this.internalJwtSecret,
        );

        if (!decryptedSubpageConfigUuid) {
            this.logger.error(`[FATAL] SubPage config ${encryptedSubpageConfigUuid} is not valid`);
            throw new NotFoundException();
        }

        const subpageConfig = this.subpageConfigMap.get(decryptedSubpageConfigUuid);

        if (!subpageConfig) {
            this.logger.error(`[FATAL] SubPage config ${decryptedSubpageConfigUuid} not found`);
            throw new NotFoundException();
        }

        return subpageConfig;
    }

    private async fetchSubscriptionPageConfigList(): Promise<string[]> {
        const subscriptionPageConfigList = await this.axiosService.getSubscriptionPageConfigList();
        if (!subscriptionPageConfigList.isOk || !subscriptionPageConfigList.response) {
            this.logger.error('Subscription page config list cannot be fetched');
            return [];
        }

        return subscriptionPageConfigList.response.configs.map((config) => config.uuid);
    }

    public getEncryptedSubpageConfigUuid(subpageConfigUuidFromRemnawave: string | null): string {
        return encryptUuid(
            this.getFinalSubpageConfigUuid(subpageConfigUuidFromRemnawave),
            this.internalJwtSecret,
        );
    }

    public getBaseSettings(
        subpageConfigUuid: string | null,
    ): TSubscriptionPageRawConfig['baseSettings'] {
        const subpageConfig = this.subpageConfigMap.get(
            this.getFinalSubpageConfigUuid(subpageConfigUuid),
        );

        if (!subpageConfig) {
            return {
                metaTitle: 'Subscription Page',
                metaDescription: 'Subscription Page',
                showConnectionKeys: false,
                hideGetLinkButton: false,
            };
        }

        return {
            metaTitle: subpageConfig.baseSettings.metaTitle,
            metaDescription: subpageConfig.baseSettings.metaDescription,
            showConnectionKeys: subpageConfig.baseSettings.showConnectionKeys,
            hideGetLinkButton: subpageConfig.baseSettings.hideGetLinkButton,
        };
    }

    private getFinalSubpageConfigUuid(subpageConfigUuid: string | null): string {
        let finalSubpageConfigUuid: string;

        const isDefaultUuid = this.subpageConfigUuid === SUBPAGE_DEFAULT_CONFIG_UUID;

        if (isDefaultUuid && subpageConfigUuid) {
            finalSubpageConfigUuid = subpageConfigUuid;
        } else {
            finalSubpageConfigUuid = this.subpageConfigUuid;
        }

        return finalSubpageConfigUuid;
    }

    private generateJwtForCookie(uuid: string | null): string {
        return this.jwtService.sign(
            {
                sessionId: nanoid(32),
                su: this.getEncryptedSubpageConfigUuid(uuid),
            },
            {
                expiresIn: '33m',
            },
        );
    }

    public async serveWebpage(
        clientIp: string,
        req: Request,
        res: Response,
        shortUuid: string,
    ): Promise<void> {
        try {
            const subscriptionDataResponse = await this.axiosService.getSubscriptionInfo(
                clientIp,
                shortUuid,
            );

            if (!subscriptionDataResponse.isOk || !subscriptionDataResponse.response) {
                res.socket?.destroy();
                return;
            }

            const subpageConfigResponse = await this.axiosService.getSubpageConfig(
                shortUuid,
                req.headers,
            );

            if (!subpageConfigResponse.isOk || !subpageConfigResponse.response) {
                res.socket?.destroy();
                return;
            }

            const subpageConfig = subpageConfigResponse.response;

            if (subpageConfig.webpageAllowed === false) {
                this.logger.log(`Webpage access is not allowed by Remnawave X's SRR.`);
                res.socket?.destroy();
                return;
            }

            const baseSettings = this.getBaseSettings(subpageConfig.subpageConfigUuid);

            const subscriptionData = subscriptionDataResponse.response;

            if (!baseSettings.showConnectionKeys) {
                subscriptionData.response.links = [];
                subscriptionData.response.ssConfLinks = {};
            }

            res.cookie('session', this.generateJwtForCookie(subpageConfig.subpageConfigUuid), {
                httpOnly: true,
                secure: !isDevelopment(),
                maxAge: 1_800_000, // 30 minutes
            });

            res.type('html').send(
                this.indexTemplate({
                    metaTitle: baseSettings.metaTitle,
                    metaDescription: baseSettings.metaDescription,
                    panelData: Buffer.from(JSON.stringify(subscriptionData)).toString('base64'),
                }),
            );
        } catch (error) {
            this.logger.error(`Error in returnWebpage: ${error}`);

            res.socket?.destroy();
            return;
        }
    }

    public serveLandingPage(res: Response): void {
        const title = 'Remnawave X';
        const downloadUrl = 'https://github.com/samur005/AntiBS2client-releases/releases/latest';
        const iconUrl =
            'https://raw.githubusercontent.com/samur005/AntiBS2client-src/HEAD/android/app/src/main/ic_launcher-playstore.png';
        res.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background:#0b1220; color:#e8eef7; }
    main { width:min(28rem, calc(100% - 2rem)); text-align:center; }
    h1 { margin:0 0 .5rem; font-size:1.75rem; }
    p { margin:0 0 1.25rem; color:#9aa8bc; line-height:1.5; }
    a.app { display:inline-flex; align-items:center; gap:.75rem; padding:.75rem 1rem;
      border:1px solid rgba(255,255,255,.12); border-radius:.75rem; color:#e8eef7;
      text-decoration:none; background:rgba(255,255,255,.04); }
    a.app:hover { background:rgba(34,211,238,.12); border-color:rgba(34,211,238,.4); }
    a.app img { width:40px; height:40px; border-radius:10px; }
  </style>
</head>
<body>
  <main>
    <h1>Remnawave X</h1>
    <p>Open your personal subscription link to see your keys and apps.</p>
    <a class="app" href="${downloadUrl}">
      <img src="${iconUrl}" alt="AntiBS2client"/>
      <span>Download AntiBS2client from GitHub</span>
    </a>
  </main>
</body>
</html>`);
    }

}
