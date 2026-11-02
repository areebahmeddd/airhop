// Text set in capitals, for section headings and badges.
//
// Used in place of `textTransform: "uppercase"`, for the reason `upper-case.ts`
// gives. String children are cased in the reading language by `upperCase`;
// anything else passes through untouched.

import { upperCase, useLanguage } from "@i18n";
import React from "react";
import { Text, type TextProps } from "react-native";

export default function UpperText({
  children,
  ...props
}: TextProps): React.JSX.Element {
  const language = useLanguage();
  return (
    <Text {...props}>
      {React.Children.map(children, (child) =>
        typeof child === "string" ? upperCase(child, language) : child,
      )}
    </Text>
  );
}
