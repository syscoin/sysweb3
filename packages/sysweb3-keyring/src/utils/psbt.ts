import * as syscoinjs from 'syscoinjs-lib';

/**
 * Utility functions for PSBT conversion between Pali and syscoinjs formats
 */
export class PsbtUtils {
  /**
   * Import PSBT from Pali's exported format to syscoinjs PSBT object
   * @param psbtFromPali - PSBT data exported from Pali
   * @returns syscoinjs PSBT object
   */
  static fromPali(psbtFromPali: any): any {
    return syscoinjs.utils.importPsbtFromJson(psbtFromPali).psbt;
  }

  /**
   * Export syscoinjs PSBT object to Pali's expected format
   * @param psbt - syscoinjs PSBT object
   * @returns PSBT data in Pali's expected format
   */
  static toPali(psbt: any): any {
    return syscoinjs.utils.exportPsbtToJson(psbt, undefined);
  }
}
