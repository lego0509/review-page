'use client';

import { TextareaHTMLAttributes, useMemo } from 'react';
import clsx from 'clsx';

interface TextCounterTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
  label: string;
  helper?: string;
}

export function TextCounterTextarea({
  value,
  onChange,
  minLength = 0,
  label,
  helper,
  className,
  ...props
}: TextCounterTextareaProps) {
  const remaining = useMemo(() => Math.max(0, minLength - value.length), [minLength, value.length]);
  const isShort = value.length < minLength;

  return (
    <div className={clsx('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <label className="label">{label}</label>
        <span className="text-xs text-gray-500">{`${value.length} / ${minLength}文字`}</span>
      </div>
      {helper && <p className="subtext">{helper}</p>}
      <textarea
        {...props}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="control min-h-[120px] resize-none"
      />
      <div className="flex items-center justify-between text-xs">
        <span className={clsx('font-semibold', isShort ? 'text-red-500' : 'text-gray-500')}>
          {isShort ? `あと${remaining}文字必要です` : '入力ありがとうございます'}
        </span>
      </div>
    </div>
  );
}

export default TextCounterTextarea;
