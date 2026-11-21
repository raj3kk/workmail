import type { Metadata } from "next";import "./globals.css";
export const metadata:Metadata={title:"WorkMail — Business Email",description:"Custom-domain business email workspace"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
