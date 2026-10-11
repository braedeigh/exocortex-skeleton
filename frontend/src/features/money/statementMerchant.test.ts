import { describe, expect, it } from 'vitest';
import { readStatementMerchant } from './statementMerchant';

/** Every key must appear inside the line — the server matches rules by substring. */
function read(desc: string) {
  const merchant = readStatementMerchant(desc);
  expect(desc.toLowerCase()).toContain(merchant.key);
  return merchant;
}

describe('readStatementMerchant', () => {
  it('strips processor prefix, date, and cut-off location from card purchases', () => {
    expect(read('TST*COSMIC COFFEE - EAS 04/15 MOBILE PURCHASE Austin TX')).toEqual({
      key: 'cosmic coffee',
      name: 'Cosmic Coffee',
    });
    expect(read('SQ *MEDICI ROASTING - D 03/15 MOBILE PURCHASE Austin TX').name).toBe('Medici Roasting');
  });

  it('drops store numbers and order codes', () => {
    expect(read('H-E-B #218 03/14 MOBILE PURCHASE AUSTIN TX')).toEqual({ key: 'h-e-b', name: 'H-E-B' });
    expect(read('SHELL OIL 57544800006 03/28 MOBILE PURCHASE AUSTIN TX').key).toBe('shell oil');
    expect(read('AMAZON MKTPL*EB9HF1IN3 05/14 PURCHASE Amzn.com/bill WA').key).toBe('amazon mktpl');
    expect(read('064 TORCHYS NORTHSHORE 06/27 MOBILE PURCHASE AUSTIN TX').key).toBe('torchys northshore');
    expect(read('7-ELEVEN 36555 05/25 PURCHASE LEANDER TX').name).toBe('7-Eleven');
  });

  it('reads the real payee out of a payment-app transfer', () => {
    expect(read('PAYPAL DES:INST XFER ID:UBER INDN:SOMEONE CO ID:PAYPALSI77 WEB')).toEqual({
      key: 'id:uber',
      name: 'Uber',
    });
  });

  it('uses the payer before DES: for other bank transfers', () => {
    expect(read('ACME HEALTH DES:PAYROLLREG ID:70130707808SP1 INDN:SOMEONE CO ID:17 PPD')).toEqual({
      key: 'acme health',
      name: 'Acme Health',
    });
    expect(read('PL*PAYLEASE DES:WEB PMTS ID:W71809 INDN:SOMEONE').key).toBe('paylease');
  });

  it('keys a Zelle on the whole phrase but names the person', () => {
    expect(read('Zelle payment to JANE DOE Conf# abc123')).toEqual({
      key: 'zelle payment to jane doe',
      name: 'Jane Doe',
    });
  });

  it('falls back to the first two words when too little is left', () => {
    expect(read('SQ *AB 07/11 PURCHASE Austin TX').key).toBe('sq *ab');
    expect(readStatementMerchant('')).toEqual({ key: '', name: '' });
  });
});
