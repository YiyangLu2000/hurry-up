import { describe, expect, it } from 'vitest'
import { blockedLocationSteps, detectBrowser } from './location'

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
}

describe('detectBrowser', () => {
  it('recognises each browser family', () => {
    expect(detectBrowser(UA.iphoneSafari)).toBe('ios')
    expect(detectBrowser(UA.iphoneChrome)).toBe('ios')
    expect(detectBrowser(UA.macSafari)).toBe('safari')
    expect(detectBrowser(UA.macChrome)).toBe('chrome')
    expect(detectBrowser(UA.windowsEdge)).toBe('edge')
    expect(detectBrowser(UA.windowsFirefox)).toBe('firefox')
    expect(detectBrowser(UA.androidChrome)).toBe('android-chrome')
  })

  it('treats a touch "Mac" as an iPad', () => {
    expect(detectBrowser(UA.macSafari, 5)).toBe('ios')
  })
})

describe('blockedLocationSteps', () => {
  it('sends iPhone users to the Settings app, naming their browser', () => {
    expect(blockedLocationSteps(UA.iphoneSafari).join(' ')).toMatch(/Settings app.*Safari Websites/)
    expect(blockedLocationSteps(UA.iphoneChrome).join(' ')).toMatch(/tap Chrome/)
  })

  it('gives browser-specific desktop steps', () => {
    expect(blockedLocationSteps(UA.macChrome)[0]).toMatch(/site-controls icon/)
    expect(blockedLocationSteps(UA.macSafari)[0]).toMatch(/Safari → Settings/)
    expect(blockedLocationSteps(UA.windowsFirefox)[0]).toMatch(/location icon/)
  })
})
