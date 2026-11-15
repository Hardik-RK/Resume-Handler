import type { SVGProps } from 'react';
import { ICON_SYMBOLS } from './icon-symbols';

export type IconName = 'check' | 'chevron' | 'x' | 'send' | 'inbox' | 'table' | 'filetext' | 'refresh' | 'lock' | 'plus' | 'minus' | 'moon' | 'sun';

// The inline SVG sprite: render <IconSprite /> once at the root, then <Icon name="check" />.
export function IconSprite() {
  return <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON_SYMBOLS }} />;
}

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: 'sm' | 'lg';
}

export function Icon({ name, size, className = '', ...rest }: IconProps) {
  const sizeClass = size === 'sm' ? ' icon-sm' : size === 'lg' ? ' icon-lg' : '';
  return <svg className={`icon${sizeClass}${className ? ` ${className}` : ''}`} aria-hidden="true" {...rest}><use href={`#i-${name}`} /></svg>;
}
