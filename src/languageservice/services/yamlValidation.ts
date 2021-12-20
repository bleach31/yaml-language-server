/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { Diagnostic, Position } from 'vscode-languageserver';
import { LanguageSettings } from '../yamlLanguageService';
import { YAMLDocument, YamlVersion } from '../parser/yamlParser07';
import { SingleYAMLDocument } from '../parser/yamlParser07';
import { YAMLSchemaService } from './yamlSchemaService';
import { YAMLDocDiagnostic } from '../utils/parseUtils';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { JSONValidation } from 'vscode-json-languageservice/lib/umd/services/jsonValidation';
import { YAML_SOURCE } from '../parser/jsonParser07';
import { TextBuffer } from '../utils/textBuffer';
import { yamlDocumentsCache, YamlDocuments } from '../parser/yaml-documents';
import { NODE_TYPE } from 'yaml/dist/nodes/Node';
import { AnyRecord } from 'dns';
import { Token } from 'yaml/dist/parse/cst';


/**
 * Convert a YAMLDocDiagnostic to a language server Diagnostic
 * @param yamlDiag A YAMLDocDiagnostic from the parser
 * @param textDocument TextDocument from the language server client
 */
export const yamlDiagToLSDiag = (yamlDiag: YAMLDocDiagnostic, textDocument: TextDocument): Diagnostic => {
  const start = textDocument.positionAt(yamlDiag.location.start);
  const range = {
    start,
    end: yamlDiag.location.toLineEnd
      ? Position.create(start.line, new TextBuffer(textDocument).getLineLength(start.line))
      : textDocument.positionAt(yamlDiag.location.end),
  };

  return Diagnostic.create(range, yamlDiag.message, yamlDiag.severity, yamlDiag.code, YAML_SOURCE);
};

export class YAMLValidation {
  private validationEnabled: boolean;
  private customTags: string[];
  private jsonValidation;
  private disableAdditionalProperties: boolean;
  private yamlVersion: YamlVersion;

  private MATCHES_MULTIPLE = 'Matches multiple schemas when only one must validate.';

  public constructor(schemaService: YAMLSchemaService) {
    this.validationEnabled = true;
    this.jsonValidation = new JSONValidation(schemaService, Promise);
  }

  public configure(settings: LanguageSettings): void {
    if (settings) {
      this.validationEnabled = settings.validate;
      this.customTags = settings.customTags;
      this.disableAdditionalProperties = settings.disableAdditionalProperties;
      this.yamlVersion = settings.yamlVersion;
    }
  }

  public async doValidation(textDocument: TextDocument, isKubernetes = false): Promise<Diagnostic[]> {
    if (!this.validationEnabled) {
      return Promise.resolve([]);
    }

    const validationResult = [];
    try {
      const yamlDocument: YAMLDocument = yamlDocumentsCache.getYamlDocument(
        textDocument,
        { customTags: this.customTags, yamlVersion: this.yamlVersion },
        true
      );

      let index = 0;
      //////////////////////////////////////////////////////////////////////////////////
      // 検証用リスト作成
      let outPortArray: Array<string> = [];
      let typeArray: Array<string> = [];
      let documentPath = ""
      if (textDocument.uri.includes("%3A")) {
        console.warn(`windows`);
        documentPath = textDocument.uri.replace(/^file:\/\/\/([a-z])%3A/, "$1:");
      }
      else {
        console.warn(`linux`);
        documentPath = textDocument.uri.replace(/^file:\/\//, "");
      }
      this.addAllFileKey(documentPath, "OutputPorts", outPortArray)
      this.addAllFileKey(documentPath, "Types", typeArray)
      //////////////////////////////////////////////////////////////////////////////////

      for (const currentYAMLDoc of yamlDocument.documents) {
        currentYAMLDoc.isKubernetes = isKubernetes;
        currentYAMLDoc.currentDocIndex = index;
        currentYAMLDoc.disableAdditionalProperties = this.disableAdditionalProperties;
        const validation = await this.jsonValidation.doValidation(textDocument, currentYAMLDoc);
        const syd = (currentYAMLDoc as unknown) as SingleYAMLDocument;
        if (syd.errors.length > 0) {
          // TODO: Get rid of these type assertions (shouldn't need them)
          validationResult.push(...syd.errors);
        }
        if (syd.warnings.length > 0) {
          validationResult.push(...syd.warnings);
        }
        //////////////////////////////////////////////////////////////////////////////////
        //ポート
        let children = currentYAMLDoc.root.children;
        for (let ent1 of children.entries()) {
          let ent1any = ent1[1] as any
          if (ent1any.keyNode.value == "InputPorts") {
            for (let ent2 of ent1[1].children.entries()) {
              let ent2any = ent2[1] as any
              for (let ent2kvs of ent2any.parent.internalNode.value.items[0].items) {
                if (ent2kvs.key.source == "ConnectedPort") {
                  //console.warn(ent2kvs.value.source) // 検証対象
                  if (!outPortArray.includes(ent2kvs.value.source)) {
                    validationResult.push(this.makeTammodDiagnostics("未定義のポートです:" + ent2kvs.value.source, ent2kvs.value.range[0], ent2kvs.value.range[2]))
                  }
                }
              }
            }
          }
        }
        //////////////////////////////////////////////////////////////////////////////////
        //タイプ
        for (let ent1 of children.entries()) {
          let ent1any = ent1[1] as any
          if (ent1any.keyNode.value == "InputPorts" || ent1any.keyNode.value == "OutputPorts") {
            for (let ent2 of ent1[1].children.entries()) {
              let ent2any = ent2[1] as any
              for (let ent2kvs of ent2any.parent.internalNode.value.items[0].items) {
                if (ent2kvs.key.source == "PortType") {
                  //console.warn(ent2kvs.value.source) // 検証対象
                  if (!typeArray.includes(ent2kvs.value.source)) {
                    validationResult.push(this.makeTammodDiagnostics("未定義の型です:" + ent2kvs.value.source, ent2kvs.value.range[0], ent2kvs.value.range[2]))
                  }
                }
              }
            }
          }
        }
        //////////////////////////////////////////////////////////////////////////////////
        validationResult.push(...validation);
        index++;
      }
    } catch (err) {
      console.error(err.toString());
    }
    let previousErr: Diagnostic;
    const foundSignatures = new Set();
    const duplicateMessagesRemoved: Diagnostic[] = [];
    for (let err of validationResult) {
      /**
       * A patch ontop of the validation that removes the
       * 'Matches many schemas' error for kubernetes
       * for a better user experience.
       */
      if (isKubernetes && err.message === this.MATCHES_MULTIPLE) {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(err, 'location')) {
        err = yamlDiagToLSDiag(err, textDocument);
      }

      if (!err.source) {
        err.source = YAML_SOURCE;
      }

      if (
        previousErr &&
        previousErr.message === err.message &&
        previousErr.range.end.line === err.range.start.line &&
        Math.abs(previousErr.range.end.character - err.range.end.character) >= 1
      ) {
        previousErr.range.end = err.range.end;
        continue;
      } else {
        previousErr = err;
      }

      const errSig = err.range.start.line + ' ' + err.range.start.character + ' ' + err.message;
      if (!foundSignatures.has(errSig)) {
        duplicateMessagesRemoved.push(err);
        foundSignatures.add(errSig);
      }
    }

    return duplicateMessagesRemoved;
  }
  /////////////////////////////////////////////////////////
  // 新しい関数
  private makeTammodDiagnostics(message: string, start: number, end: number): YAMLDocDiagnostic {
    return {
      message: message,
      location: {
        start: start,
        end: end,
        toLineEnd: true,
      },
      severity: 1,
      code: 1, // ErrorCode.EnumValueMismatch 
    };
  }
  private addAllFileKey(currentPath: string, key: String, result: Array<string>): void {
    // Loading another files
    let fs = require('fs');
    let glob = require('glob');
    let path = require('path');
    let allFileList = glob.sync(path.dirname(currentPath) + '/*.tam.yml');
    let currentName = path.basename(currentPath, '.tam.yml')
    for (let filePath of allFileList) {
      let context = fs.readFileSync(filePath, 'utf-8');
      let documentOther = TextDocument.create(filePath, 'yaml', 1, context)
      let yamlDocument = new YamlDocuments();
      let docOther = yamlDocument.getYamlDocument(documentOther, { customTags: this.customTags, yamlVersion: this.yamlVersion }, true);

      let fileName = path.basename(filePath, '.tam.yml')
      if (fileName == currentName)
        this.addKey(docOther.tokens[0], key, result, "");
      else
        this.addKey(docOther.tokens[0], key, result, fileName + "/");
    }
  }
  private addKey(document: Token, key: String, result: Array<string>, prefix: String): void {
    if (document.type === `document`) { //型チェック
      if (document.value.type === `block-map`) { // 型チェック
        for (let temp_item of document.value.items) {
          if (temp_item.key.type === `scalar`) { //型チェック
            if (temp_item.key.source === key && temp_item.value.type == `block-seq`) {
              console.warn(temp_item.value.items);
              console.warn(temp_item.value.items.length);
              for (let internal_type_def of temp_item.value.items) {
                console.warn(internal_type_def);
                if (internal_type_def.value.type === `block-map`) {  //型チェック
                  for (let internal_type of internal_type_def.value.items) {
                    if (internal_type.key.type === "scalar" && internal_type.value.type === "scalar") {//型チェック
                      if (internal_type.key.source === "Name") {

                        result.push(prefix + internal_type.value.source)
                        break
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  /////////////////////////////////////////////////////////
}
